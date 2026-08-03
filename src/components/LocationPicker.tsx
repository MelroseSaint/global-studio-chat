import { useAction } from "convex/react";
import { Loader2, LocateFixed, MapPin, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { getBrowserLocation } from "@/lib/geo";
import { cn } from "@/lib/utils";

/**
 * A picked place: a public label, optionally with coordinates. Coordinates
 * are never precise — every source (search, reverse geocode, browser
 * location) is coarsened before it is stored, and `updateProfile` coarsens
 * again on write. Clients still receive coords here because the picker
 * needs them to save the anchor, but no other surface ever shows them.
 */
export interface PickedLocation {
  label?: string;
  latitude?: number;
  longitude?: number;
}

interface PlaceResult {
  label: string;
  latitude: number;
  longitude: number;
}

interface LocationPickerProps {
  value: PickedLocation | null;
  onChange: (loc: PickedLocation | null) => void;
  placeholder?: string;
  id?: string;
  /**
   * When true (default), free-typed text that isn't a picked result is
   * committed as a label-only location on blur/Enter. Set false in surfaces
   * that need coordinates (e.g. post tagging) so only real picks count.
   */
  allowLabelOnly?: boolean;
}

/**
 * Search-or-type place picker. The search itself runs server-side (a Convex
 * mutation → Nominatim, cached), so the browser never talks to a
 * third-party geocoder directly. Also offers "use my current location",
 * which reverse geocodes server-side for a readable label.
 */
export function LocationPicker({
  value,
  onChange,
  placeholder = "Search a place, e.g. Brooklyn, NY",
  id,
  allowLabelOnly = true,
}: LocationPickerProps) {
  const searchPlaces = useAction(api.places.searchPlaces);
  const reverseGeocode = useAction(api.places.reverseGeocode);
  const [query, setQuery] = useState(value?.label ?? "");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Debounced server-side search; the browser never talks to a geocoder.
  // State is only updated inside the timer callback (or after a cleared
  // timer) so the effect never writes synchronously.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      const t = setTimeout(() => {
        setResults([]);
        setSearching(false);
        setOpen(false);
      }, 300);
      return () => clearTimeout(t);
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await searchPlaces({ query: q });
        setResults(res);
        setHighlight(0);
        setOpen(res.length > 0);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [query, searchPlaces]);

  // Click / touch outside closes the dropdown.
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, []);

  const select = (r: PlaceResult) => {
    onChange({ label: r.label, latitude: r.latitude, longitude: r.longitude });
    setQuery(r.label);
    setOpen(false);
  };

  /**
   * Commit free-typed text as a label-only location. Only fires when the
   * caller accepts label-only values and the text actually changed — a
   * plain re-save of the existing label keeps the stored anchor (the
   * server preserves coords on unchanged labels).
   *
   * This is wired to onBlur, which fires BEFORE the subsequent click on a
   * result / "Use my current location" / X-remove. That's intentional and
   * safe: the click's own onChange always runs after and overrides the
   * blur commit (and in coordinate-required surfaces allowLabelOnly=false
   * makes this a no-op anyway).
   */
  const commitTypedLabel = () => {
    if (!allowLabelOnly) return;
    const text = query.trim();
    if (text.length === 0 || text === value?.label) return;
    onChange({ label: text });
  };

  const applyMyLocation = async () => {
    if (locating) return;
    setLocating(true);
    try {
      const pos = await getBrowserLocation();
      if (pos === null) {
        toast.error("Location access was denied. You can search for a place instead.");
        return;
      }
      try {
        const place = await reverseGeocode({
          latitude: pos.latitude,
          longitude: pos.longitude,
        });
        if (place !== null) {
          onChange({
            label: place.label,
            latitude: place.latitude,
            longitude: place.longitude,
          });
          setQuery(place.label);
        } else {
          // Reverse geocode failed — keep the raw point with a label; the
          // server coarsens again on write.
          onChange({
            label: "Near you",
            latitude: pos.latitude,
            longitude: pos.longitude,
          });
          setQuery("Near you");
        }
      } catch {
        onChange({
          label: "Near you",
          latitude: pos.latitude,
          longitude: pos.longitude,
        });
        setQuery("Near you");
      }
      setOpen(false);
    } finally {
      setLocating(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open && results[highlight]) {
        e.preventDefault();
        select(results[highlight]);
      } else {
        e.preventDefault();
        commitTypedLabel();
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className="relative w-full">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          id={id}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onBlur={commitTypedLabel}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="h-10 w-full rounded-md border bg-transparent pl-9 pr-9 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring"
        />
        {searching ? (
          <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : value ? (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setQuery("");
              setOpen(false);
            }}
            aria-label="Remove location"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {open && results.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-60 overflow-auto rounded-lg border bg-background p-1 shadow-lg">
          {results.map((r, i) => (
            <li key={`${r.latitude}-${r.longitude}-${r.label}`}>
              <button
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => select(r)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  i === highlight ? "bg-muted" : "",
                )}
              >
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{r.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    Stored as a nearby area — never exact
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => void applyMyLocation()}
        disabled={locating}
        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary transition-opacity hover:opacity-80 disabled:opacity-60"
      >
        {locating ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <LocateFixed className="size-3.5" />
        )}
        {locating ? "Locating…" : "Use my current location"}
      </button>
    </div>
  );
}
