import { SubtitlesGenerator } from './../subtitles/subtitles-generator';
import { AudioUtils } from '../ffmpeg/audio-utils';
import { Helpers } from '../utils/helpers';
import { Transcriber } from '../transcription/transcriber';
import type { AllowedLanguages, AudioOriginalLangAllowed, TranscriptionDataTypes } from '../types';
import { Formatter } from '../transcription/formatter';
import { Spleeter } from '../separator/spleeter';
import { SpeechGenerator } from '../speech/speechGenerator';
import { Adaptation } from '../smart-sync/adaptation';
import { VideoUtils } from '../ffmpeg/video-utils';
import fsPromises from 'fs/promises';
import fs from 'fs';
import { Lipsync } from '../lipsync/lipsync';
import crypto from 'crypto';
import path from 'path';
import readline from 'readline/promises';

const createManualTranslationDraft = ({
  transcription,
  targetLanguage,
  originLanguage,
  transcriptionSummary,
}: {
  transcription: Awaited<ReturnType<typeof Formatter.formatTranscription>>;
  targetLanguage: AllowedLanguages;
  originLanguage: AudioOriginalLangAllowed;
  transcriptionSummary: string;
}) => {
  return {
    meta: {
      createdAt: new Date().toISOString(),
      sourceLanguage: originLanguage,
      targetLanguage,
      transcriptionSummary,
      instructions:
        'Translate each segment.transcription value to the targetLanguage and keep all existing fields unchanged.',
    },
    segments: transcription,
  };
};

const waitForManualTranslation = async ({
  transcription,
  targetLanguage,
  originLanguage,
  transcriptionSummary,
}: {
  transcription: Awaited<ReturnType<typeof Formatter.formatTranscription>>;
  targetLanguage: AllowedLanguages;
  originLanguage: AudioOriginalLangAllowed;
  transcriptionSummary: string;
}) => {
  const draftFilePath = path.join(
    process.cwd(),
    'temporary-files',
    `translation-draft-${crypto.randomUUID()}.json`,
  );

  await fsPromises.mkdir(path.dirname(draftFilePath), { recursive: true });

  const translationDraft = createManualTranslationDraft({
    transcription,
    targetLanguage,
    originLanguage,
    transcriptionSummary,
  });

  await fsPromises.writeFile(draftFilePath, JSON.stringify(translationDraft, null, 2), 'utf-8');

  console.info('OpenAI translation step skipped: manual translation mode enabled.');
  console.info(`Translation file created: ${draftFilePath}`);
  console.info('Translate the file and save changes, then type "continue" to proceed.');

  const cli = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (await cli.question('> ')).trim().toLowerCase();

      if (answer === 'continue') {
        break;
      }

      console.info('Unknown command. Please type "continue" when translation is ready.');
    }
  } finally {
    cli.close();
  }

  const translatedFileContent = await fsPromises.readFile(draftFilePath, 'utf-8');
  const parsedDraft = JSON.parse(translatedFileContent) as {
    segments?: unknown;
  };

  if (!Array.isArray(parsedDraft.segments)) {
    throw new Error(`Translated file ${draftFilePath} does not contain a valid "segments" array.`);
  }

  return {
    draftFilePath,
    translatedSegments: parsedDraft.segments,
  };
};

export type DebugMode = 'yes' | 'no';
export type NumberOfSpeakers = 'auto-detect' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10';
export type ActivateLipSync = 'yes' | 'no';
export type ActivateSubtitle = 'yes' | 'no';

export const translate = async () => {
  const targetLanguage = (process.env.TARGET_LANGUAGE || 'english') as AllowedLanguages;
  const debugMode: DebugMode = (process.env.DEBUG_MODE as DebugMode) || 'no';
  const numberOfSpeakers: NumberOfSpeakers = (process.env.NUM_SPEAKERS as NumberOfSpeakers) || 'auto-detect';
  const activateLipSync: ActivateLipSync = (process.env.APPLY_LIPSYNC as ActivateLipSync) || 'no';
  const activateSubtitle: ActivateSubtitle = (process.env.ACTIVATE_SUBTITLE as ActivateSubtitle) || 'yes';

  let clonedVoicesIdsToDelete: string[] = [];

  const transcriptionData: TranscriptionDataTypes = {
    summary: null,
    formattedSegments: [],
    detectedAudioLanguage: null,
  };

  if (debugMode === 'no') {
    console.debug = () => {};
    console.info('Dubbing Started successfully with the following parameters:');
    console.info('Target Language: ', targetLanguage);
    console.info('Debug Mode: ', debugMode);
    console.info('Number of Speakers: ', numberOfSpeakers);
    console.info('Activate Lip Sync: ', activateLipSync);
    console.info('Activate Subtitle: ', activateSubtitle);
  }

  Helpers.verifyPrerequisitesForDubbing();

  let inputFilePath = '';
  let videoPathWithoutAudio = null;
  let audioPathWithoutVideo = null;
  let backgroundAudio = null;
  let vocalsIsolated = null;

  try {
    inputFilePath = await Helpers.getAllInputFilePaths();
    const fileType = Helpers.getFileType(inputFilePath);

    if (fileType === 'video') {
      const { videoPath, audioPath } = await AudioUtils.separateAudioAndVideo(inputFilePath);
      videoPathWithoutAudio = videoPath;
      audioPathWithoutVideo = audioPath;
    } else {
      const audioPathCopy = `temporary-files/original-audio-${crypto.randomUUID()}.wav`;
      await fsPromises.copyFile(inputFilePath, audioPathCopy);
      audioPathWithoutVideo = audioPathCopy;
    }

    const transcription = await Transcriber.transcribeAudio({
      audioPath: audioPathWithoutVideo,
      numberOfSpeakers,
    });

    transcriptionData.detectedAudioLanguage = transcription.result.transcription
      .languages[0] as AudioOriginalLangAllowed;

    const transcriptionSummary = transcription.result.summarization.results;

    const formattedTranscription = Formatter.formatTranscription(
      transcription,
      transcriptionData.detectedAudioLanguage,
    );

    const { draftFilePath, translatedSegments } = await waitForManualTranslation({
      transcription: formattedTranscription,
      targetLanguage,
      originLanguage: transcriptionData.detectedAudioLanguage,
      transcriptionSummary: transcriptionSummary || '',
    });

    const verifiedTranscription = Helpers.parseAndVerifyTranscriptionDetails(JSON.stringify(translatedSegments));

    console.info(`Manual translation loaded from: ${draftFilePath}`);

    ({ backgroundAudio, vocalsIsolated } = await Spleeter.getSeparateAudio(audioPathWithoutVideo));
    const isolatedVocalsAverageDecibel = await AudioUtils.getAverageDecibel(vocalsIsolated);

    const { allResultsSorted, clonedVoicesIds } = await SpeechGenerator.getSpeechArrayFromTranscriptions({
      segments: verifiedTranscription,
      targetLanguage,
      isolatedVocalsPath: vocalsIsolated,
    });

    clonedVoicesIdsToDelete = Object.values(clonedVoicesIds);

    const speechWithDuration = await SpeechGenerator.getEachSpeechDuration({
      speechArray: allResultsSorted,
      transcriptions: verifiedTranscription,
    });

    const speechesWithoutSilence =
      await SpeechGenerator.removeStartAndEndSilenceFromAllAudio(speechWithDuration);

    const adaptedSpeeches = await Adaptation.compareAndAdjustSpeeches({
      transcriptions: verifiedTranscription,
      speeches: speechesWithoutSilence,
      clonedVoicesIds,
      originalLanguage: transcriptionData.detectedAudioLanguage,
      targetLanguage,
      transcriptionSummary,
    });

    const finalVoicesAudioTrack =
      await SpeechGenerator.createAndAssembleSeparateAudioTracksEachSpeaker(adaptedSpeeches);

    const equalizedAudio = await AudioUtils.startEqualizeAudio(finalVoicesAudioTrack);

    await AudioUtils.adjustAudioToDecibel(equalizedAudio, isolatedVocalsAverageDecibel);

    const mergedAudio = await SpeechGenerator.overlayAudioAndBackgroundMusic(equalizedAudio, backgroundAudio);

    let finalContent =
      fileType === 'audio'
        ? mergedAudio
        : await VideoUtils.getAudioMergeWithVideo(videoPathWithoutAudio!, mergedAudio);

    if (fileType === 'video' && activateSubtitle === 'yes') {
      const filePathVideoSubtitles = await SubtitlesGenerator.addSubtitlesInVideo({
        transcriptionData: verifiedTranscription,
        initialVideoPath: finalContent,
        lang: targetLanguage,
      });

      finalContent = filePathVideoSubtitles;
    }

    if (fileType === 'video' && activateLipSync === 'yes') {
      const lipSyncedVideoUrl = await Lipsync.processLipSyncWithAwsUpload({
        localAudioPath: mergedAudio,
        localVideoPath: finalContent,
      });

      const lipSyncedVideo = await fetch(lipSyncedVideoUrl).then((res) => res.arrayBuffer());
      const lipSyncedVideoBuffer = Buffer.from(lipSyncedVideo);
      const newFilePath = `output/result-${crypto.randomUUID()}.mp4`;
      await fsPromises.writeFile(newFilePath, lipSyncedVideoBuffer);

      finalContent = newFilePath;
    }

    if (fileType === 'video') {
      if (fs.existsSync(mergedAudio)) await fsPromises.unlink(mergedAudio);
    }

    console.info('Translation completed successfully, you can now find your video in the output folder.');
  } catch (error) {
    if (error instanceof Error) {
      console.error('Error:', error.message);
    } else {
      console.error('Error:', error);
    }
  } finally {
    if (videoPathWithoutAudio && fs.existsSync(videoPathWithoutAudio))
      await fsPromises.unlink(videoPathWithoutAudio);
    if (audioPathWithoutVideo && fs.existsSync(audioPathWithoutVideo))
      await fsPromises.unlink(audioPathWithoutVideo);
    if (backgroundAudio && fs.existsSync(backgroundAudio)) await fsPromises.unlink(backgroundAudio);
    if (vocalsIsolated && fs.existsSync(vocalsIsolated)) await fsPromises.unlink(vocalsIsolated);
  }
};

translate();
