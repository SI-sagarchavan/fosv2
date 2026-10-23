import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, Pressable, View, useWindowDimensions } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { Montserrat_400Regular, Montserrat_500Medium, Montserrat_700Bold } from "@expo-google-fonts/montserrat";
import { BakbakOne_400Regular } from "@expo-google-fonts/bakbak-one";
import { Inter_400Regular, Inter_500Medium, Inter_700Bold } from "@expo-google-fonts/inter";
import { Poppins_500Medium } from "@expo-google-fonts/poppins";
import { Render } from "./src/fos/Render";
import { PAGES } from "./pages";
import { PREVIEW } from "./preview.config";

/**
 * FanOS native preview: pick a bundled page and see it rendered by the React Native renderer.
 * The designs are desktop artboards, so they are scaled to fit the screen ("fit") or shown 1:1 with
 * horizontal scrolling ("1:1") — the renderer lays them out at their own design width either way.
 */
export default function App() {
  const [fontsLoaded] = useFonts({
    Montserrat_400Regular, Montserrat_500Medium, Montserrat_700Bold, BakbakOne_400Regular,
    Inter_400Regular, Inter_500Medium, Inter_700Bold, Poppins_500Medium,
  });
  const names = Object.keys(PAGES);
  const [current, setCurrent] = useState(PAGES[PREVIEW.page] ? PREVIEW.page : names[0]);
  const choose = (n: string) => { setHeight(0); setCurrent(n); };
  // follow preview.config.ts when it changes (fast refresh keeps component state otherwise)
  useEffect(() => { if (PAGES[PREVIEW.page]) choose(PREVIEW.page); setFit(PREVIEW.fit); }, [PREVIEW.page, PREVIEW.fit]);
  const [fit, setFit] = useState(PREVIEW.fit);
  const [height, setHeight] = useState(0);
  const { width: screen } = useWindowDimensions();
  const page = PAGES[current];
  const scale = fit ? Math.min(1, screen / page.width) : 1;

  const content = useMemo(() => <Render page={page} />, [page]);
  if (!fontsLoaded) return <View style={styles.center}><Text>Loading fonts…</Text></View>;

  return (
    <View style={styles.app}>
      <StatusBar style="dark" />
      <View style={styles.bar}>
        {names.map((n) => (
          <Pressable key={n} onPress={() => choose(n)} style={[styles.chip, n === current && styles.chipOn]}>
            <Text style={[styles.chipText, n === current && styles.chipTextOn]}>{n}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => setFit(!fit)} style={styles.chip}>
          <Text style={styles.chipText}>{fit ? "fit" : "1:1"}</Text>
        </Pressable>
      </View>
      <ScrollView>
        <ScrollView horizontal scrollEnabled={!fit}>
          {/* Lay out at design width, then scale the whole artboard to the screen. */}
          {/* Until the artboard has been measured, let the wrapper size to it — a 0px box here is
              clipped by the horizontal ScrollView on iOS, and the measurement then never arrives. */}
          <View style={{ width: page.width * scale, height: height ? height * scale : undefined }}>
            <View
              onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
              style={{ width: page.width, transform: [{ translateX: (-page.width * (1 - scale)) / 2 }, { translateY: (-height * (1 - scale)) / 2 }, { scale }] }}
            >
              {content}
            </View>
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#f5f5f5", paddingTop: 52 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  bar: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: "#e4e4e4" },
  chipOn: { backgroundColor: "#1f2b7b" },
  chipText: { fontSize: 12, color: "#222" },
  chipTextOn: { color: "#fff" },
});
