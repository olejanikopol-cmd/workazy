import AsyncStorage from '@react-native-async-storage/async-storage';
import { createOnboardingStore } from './onboardingStore';
export const onboardingStore = createOnboardingStore(AsyncStorage);
