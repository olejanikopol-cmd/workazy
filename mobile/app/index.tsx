import { Redirect } from 'expo-router';

/** The app opens on the Plans tab. */
export default function Index() {
  return <Redirect href="/(tabs)/plans" />;
}