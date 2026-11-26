import { requireOptionalNativeModule, type NativeModule } from 'expo';
import { Platform } from 'react-native';

type Failure = 'discarded' | 'empty' | 'offline' | 'permission' | 'unavailable';
type Event = { id: string; phase: Failure | 'recording' | 'ready' | 'playing' | 'playback_finished'; frames?: number };
type Events = { onProjectRecording: (event: Event) => void };
type LocalRecording = InstanceType<typeof NativeModule<Events>> & {
  supported(): boolean;
  start(id: string): Promise<Failure | null>;
  finish(id: string): Promise<void>;
  discard(id: string): Promise<void>;
  copyClip(id: string): Promise<Uint8Array<ArrayBuffer> | null>;
  play(id: string): Promise<boolean>;
  stopPlayback(id: string): Promise<void>;
};

export const localProjectRecording = Platform.OS === 'android'
  ? requireOptionalNativeModule<LocalRecording>('QingyuLocalProjectRecording') : null;
