import { requireOptionalNativeModule, type NativeModule } from 'expo';
import { Platform } from 'react-native';

type Event = {
  id: string;
  phase: 'listening' | 'partial' | 'finishing' | 'result' | 'cancelled' | 'permission' | 'unavailable' | 'failed';
  text?: string;
};
type Events = { onDictation: (event: Event) => void };

type LocalDictation = InstanceType<typeof NativeModule<Events>> & {
  getLanguage(): Promise<string | null>;
  start(id: string, language: string): Promise<boolean>;
  finish(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
};

export const localDictation = Platform.OS === 'android'
  ? requireOptionalNativeModule<LocalDictation>('QingyuLocalDictation') : null;
