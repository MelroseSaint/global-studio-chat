import { useEffect, useState } from "react";

/**
 * Live connection status. `navigator.onLine` is a single snapshot; the
 * `online`/`offline` events keep it current, including when the tab regains
 * focus after being backgrounded. Used by the admin offline layer to know
 * whether moderation actions can reach the platform right now.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
