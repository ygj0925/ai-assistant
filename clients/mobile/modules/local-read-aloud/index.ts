import { requireOptionalNativeModule, type NativeModule } from 'expo';
import { Platform } from 'react-native';

export type LocalSpeechLanguage = 'zh' | 'en';
export type SpeechAvailability = {
  languages: LocalSpeechLanguage[];
  maxInputLength: number;
};

type Playback = { id: string; phase: 'started' | 'finished' | 'stopped' | 'failed' };
type Events = {
  onAvailability: (event: SpeechAvailability) => void;
  onPlayback: (event: Playback) => void;
};

type LocalReadAloud = InstanceType<typeof NativeModule<Events>> & {
  getAvailability(): Promise<SpeechAvailability>;
  speak(id: string, text: string, language: LocalSpeechLanguage): Promise<boolean>;
  stop(id: string): Promise<void>;
};

export const localReadAloud = Platform.OS === 'android'
  ? requireOptionalNativeModule<LocalReadAloud>('QingyuLocalReadAloud') : null;
