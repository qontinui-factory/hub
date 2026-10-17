import { useEffect, useState } from 'react';
import { StudioPlayer } from '@qontinui/studio-scenes/src/adapters/remotion/Player.tsx';

// One scene from the sibling plan's framework, mounted through its own web
// player (plan creative direction: the hub draws no animation of its own).
// The trace is fetched as untrusted JSON; the player validates it and shows
// its mode label (illustrative / replay) itself.
export default function ScenePlayer({ scene, aspect = '16:9', autoPlay = false, loop = false }) {
  const [trace, setTrace] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let live = true;
    fetch(`/_hub/scenes/traces/${scene}.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`trace ${scene}: HTTP ${r.status}`))))
      .then((t) => live && setTrace(t))
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [scene]);
  if (error) return <p className="scene-error" role="alert">Scene cannot be shown: {error}</p>;
  if (!trace) return <div className="scene-loading" aria-busy="true">Loading the line…</div>;
  return (
    <StudioPlayer
      scene={scene}
      trace={trace}
      aspect={aspect}
      assetBaseUrl="/_hub/scenes"
      autoPlay={autoPlay}
      loop={loop}
      controls
    />
  );
}
