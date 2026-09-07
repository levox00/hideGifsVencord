/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Hide Favorite GIFs contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import { SettingsStore } from "@shared/SettingsStore";
import { Devs, IS_MAC } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Menu, React, useEffect, useMemo, useState } from "@webpack/common";

interface GifReference {
    src?: string;
    url?: string;
    sourceUrls?: string[];
    width?: number;
    height?: number;
}

interface HiddenGif extends GifReference {
    src: string;
    url: string;
}

const DEFAULT_KEYBIND = ["Alt"];
const KEYBIND_MIGRATION_VERSION = 2;
const REVEAL_HIDE_DELAY_MS = 2000;
const MODIFIER_KEYS = new Set(["control", "ctrl", "shift", "alt", "option", "meta", "cmd", "command", "mod"]);
const HIDDEN_SETTINGS: "hiddenGifsJson"[] = ["hiddenGifsJson"];
const KEYBIND_SETTINGS: "keybind"[] = ["keybind"];
const logger = new Logger("HideFavoriteGIFs");
const visibility = new SettingsStore({ enabled: false, revealed: false });
const pressedKeys = new Set<string>();
let revealHideTimeout: number | null = null;
let pickerSubscriptions = 0;
let recordingKeybind = false;

function subscribeVisibility(listener: () => void) {
    pickerSubscriptions++;
    visibility.addGlobalChangeListener(listener);
    return () => {
        pickerSubscriptions--;
        visibility.removeGlobalChangeListener(listener);
    };
}

function getVisibilitySnapshot() {
    return visibility.plain.enabled ? (visibility.plain.revealed ? 2 : 1) : 0;
}

function useFilteredGifs<T extends GifReference>(gifs: T[]): T[] {
    const mode = React.useSyncExternalStore(subscribeVisibility, getVisibilitySnapshot);
    const { hiddenGifsJson } = settings.use(HIDDEN_SETTINGS);
    const hiddenKeys = useMemo(() => new Set(getHiddenGifs().flatMap(getGifKeys)), [hiddenGifsJson]);

    return useMemo(() => mode === 1 && hiddenKeys.size
        ? gifs.filter(gif => !getGifKeys(gif).some(key => hiddenKeys.has(key)))
        : gifs, [gifs, mode, hiddenKeys]);
}

function cleanString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeUrl(value: unknown): string {
    let text = cleanString(value);
    if (!text) return "";

    // Context menus and Discord's media proxy can hand us an encoded URL.
    // Decode a couple of layers without allowing malformed input to break
    // matching the rest of the favorites list.
    for (let i = 0; i < 2; i++) {
        try {
            const decoded = decodeURIComponent(text);
            if (decoded === text) break;
            text = decoded;
        } catch {
            break;
        }
    }

    try {
        const url = new URL(text);
        url.protocol = url.protocol.toLowerCase();
        url.hostname = url.hostname.toLowerCase();
        if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
            url.port = "";
        }
        // CDN signatures and image transformations change frequently but do
        // not identify a different GIF.
        url.search = "";
        url.hash = "";
        url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
        return url.href;
    } catch {
        return text;
    }
}

function getUrlVariants(value: unknown): string[] {
    const normalized = normalizeUrl(value);
    if (!normalized) return [];

    const variants = new Set([normalized]);

    try {
        const url = new URL(normalized);
        const host = url.hostname.toLowerCase();

        // Discord's external image proxy embeds the original URL in its path.
        // Keep both sides so a stored provider URL matches a rendered proxy
        // URL, and vice versa.
        if (host.endsWith("discordapp.net")) {
            const path = decodeURIComponent(url.pathname);
            const originalMarker = path.match(/\/(https?)\/(.+)$/i);
            if (originalMarker?.[1] && originalMarker[2]) {
                variants.add(normalizeUrl(`${originalMarker[1]}://${originalMarker[2]}`));
            }
        }

        // Discord's CDN and media proxy use different hostnames for the same
        // attachment path.
        if (host === "cdn.discordapp.com" || host === "media.discordapp.net") {
            const alternateHost = host === "cdn.discordapp.com" ? "media.discordapp.net" : "cdn.discordapp.com";
            variants.add(normalizeUrl(`https://${alternateHost}${url.pathname}`));
        }
    } catch {
        // The normalized value itself is still useful for non-URL references.
    }

    return [...variants].filter(Boolean);
}

function getProviderKeys(value: string): string[] {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        const pathParts = url.pathname.split("/").filter(Boolean);
        const keys: string[] = [];

        for (const parameter of ["id", "itemid", "gifid"]) {
            const id = url.searchParams.get(parameter)?.trim().toLowerCase();
            if (id) keys.push(`${host}:id:${id}`);
        }

        if (host.endsWith("tenor.com")) {
            const mediaId = pathParts[0];
            if (mediaId && mediaId !== "view" && mediaId !== "search" && mediaId !== "categories") {
                keys.push(`tenor:media:${mediaId.toLowerCase()}`);
            }

            const viewId = url.pathname.match(/-gif-(\d+)(?:\/)?$/i)?.[1];
            if (viewId) keys.push(`tenor:view:${viewId}`);
        }

        if (host.endsWith("giphy.com")) {
            const mediaIndex = pathParts.indexOf("media");
            if (mediaIndex >= 0 && pathParts[mediaIndex + 1]) {
                keys.push(`giphy:${pathParts[mediaIndex + 1].toLowerCase()}`);
            }

            if (pathParts[0] === "gifs" && pathParts.at(-1)) {
                const slug = pathParts.at(-1)!.split("-").at(-1);
                if (slug) keys.push(`giphy:${slug.toLowerCase()}`);
            }
        }

        return keys;
    } catch {
        return [];
    }
}

function getGifKeys(gif: GifReference): string[] {
    const urls = [gif.url, gif.src, ...(gif.sourceUrls ?? [])];
    const keys = urls.flatMap(value => getUrlVariants(value));
    const providerKeys = [...urls, ...keys].flatMap(value => getProviderKeys(cleanString(value)));
    return [...new Set([...keys, ...providerKeys])];
}

function sameGif(left: GifReference, right: GifReference): boolean {
    const rightKeys = new Set(getGifKeys(right));
    return getGifKeys(left).some(key => rightKeys.has(key));
}

function normalizeKey(key: string): string {
    if (key === " ") return "Space";
    if (key === "Esc") return "Escape";
    return key.length === 1 ? key.toUpperCase() : key;
}

function normalizeCode(code: string): string {
    return code
        .toLowerCase()
        .replace(/^key/, "")
        .replace(/^digit/, "")
        .replace(/^numpad/, "");
}

function isModifierKey(key: string): boolean {
    return MODIFIER_KEYS.has(key.toLowerCase());
}

function getModifierKey(key: string): "control" | "shift" | "alt" | "meta" | null {
    switch (key.toLowerCase()) {
        case "mod":
            return IS_MAC ? "meta" : "control";
        case "control":
        case "ctrl":
            return "control";
        case "shift":
            return "shift";
        case "alt":
        case "option":
            return "alt";
        case "meta":
        case "cmd":
        case "command":
            return "meta";
        default:
            return null;
    }
}

function addPressedModifiers(event: KeyboardEvent, keys: string[]) {
    if (event.metaKey) keys.push("Meta");
    if (event.ctrlKey) keys.push("Control");
    if (event.shiftKey) keys.push("Shift");
    if (event.altKey) keys.push("Alt");
}

function eventToKeybind(event: KeyboardEvent): string[] {
    const keys: string[] = [];
    addPressedModifiers(event, keys);

    const key = normalizeKey(event.key);
    if (key && !isModifierKey(key)) keys.push(key);

    return [...new Set(keys)];
}

function getConfiguredKeybind(): string[] {
    const raw = settings.store.keybind;
    if (Array.isArray(raw)) {
        const keybind = raw
            .filter((key): key is string => typeof key === "string")
            .map(normalizeKey)
            .filter(Boolean);
        if (keybind.length) return keybind;
    }

    return DEFAULT_KEYBIND;
}

function migrateKeybind() {
    if (settings.store.keybindMigrationVersion === KEYBIND_MIGRATION_VERSION) return;

    const current = settings.store.keybind;
    const isPreviousDefault = Array.isArray(current)
        && current.length === 1
        && typeof current[0] === "string"
        && normalizeKey(current[0]).toLowerCase() === "shift";

    if (!Array.isArray(current) || isPreviousDefault) settings.store.keybind = DEFAULT_KEYBIND;
    settings.store.keybindMigrationVersion = KEYBIND_MIGRATION_VERSION;
}

function formatKeybind(keybind: string | string[]): string {
    const keybindString = Array.isArray(keybind) ? keybind.join("+") : keybind;
    return IS_MAC
        ? keybindString.replace(/Control/gi, "^").replace(/Meta|Command|Cmd/gi, "⌘").replace(/Alt|Option/gi, "⌥").replace(/Shift/gi, "⇧")
        : keybindString;
}

function keyMatchesPressed(key: string): boolean {
    const wantedKey = normalizeKey(key).toLowerCase();
    const wantedCode = normalizeCode(key);

    return [...pressedKeys].some(pressed =>
        normalizeKey(pressed).toLowerCase() === wantedKey || normalizeCode(pressed) === wantedCode
    );
}

function isKeybindHeld(): boolean {
    const keybind = getConfiguredKeybind();
    const expectedModifiers = new Set(keybind.map(getModifierKey).filter((key): key is NonNullable<typeof key> => key !== null));
    const pressedModifiers = new Set([...pressedKeys].map(getModifierKey).filter((key): key is NonNullable<typeof key> => key !== null));

    if (expectedModifiers.size !== pressedModifiers.size) return false;
    if ([...expectedModifiers].some(key => !pressedModifiers.has(key))) return false;

    return keybind.filter(key => !isModifierKey(key)).every(key => keyMatchesPressed(key));
}

function trackKey(event: KeyboardEvent, pressed: boolean) {
    const key = normalizeKey(event.key);
    const code = normalizeCode(event.code);

    for (const [name, held] of [
        ["Control", event.ctrlKey], ["Shift", event.shiftKey],
        ["Alt", event.altKey], ["Meta", event.metaKey],
    ] as const) {
        if (held) pressedKeys.add(name);
        else pressedKeys.delete(name);
    }

    if (isModifierKey(key)) return;

    if (pressed) {
        if (key) pressedKeys.add(key);
        if (code) pressedKeys.add(code);
    } else {
        if (key) pressedKeys.delete(key);
        if (code) pressedKeys.delete(code);
    }
}

function cancelRevealHide() {
    if (revealHideTimeout === null) return;

    window.clearTimeout(revealHideTimeout);
    revealHideTimeout = null;
}

function showRevealedGifs() {
    cancelRevealHide();
    visibility.store.revealed = true;
}

function scheduleRevealHide() {
    if (!visibility.plain.revealed || revealHideTimeout !== null) return;

    revealHideTimeout = window.setTimeout(() => {
        revealHideTimeout = null;
        if (isKeybindHeld()) return;

        visibility.store.revealed = false;
    }, REVEAL_HIDE_DELAY_MS);
}

function syncRevealKeybind() {
    if (isKeybindHeld()) {
        showRevealedGifs();
    } else {
        scheduleRevealHide();
    }
}

function handleKeyDown(event: KeyboardEvent) {
    if (recordingKeybind) return;
    trackKey(event, true);
    if (isKeybindHeld() && pickerSubscriptions) event.preventDefault();
    syncRevealKeybind();
}

function handleKeyUp(event: KeyboardEvent) {
    if (recordingKeybind) return;
    if (visibility.plain.revealed && pickerSubscriptions && isModifierKey(normalizeKey(event.key))) event.preventDefault();
    trackKey(event, false);
    syncRevealKeybind();
}

function clearPressedKeys() {
    pressedKeys.clear();
    scheduleRevealHide();
}

function sanitizeHiddenGifs(value: unknown): HiddenGif[] {
    if (!Array.isArray(value)) return [];
    return value
        .map(asRecord)
        .filter((gif): gif is Record<string, unknown> => gif !== null)
        .map(gif => {
            const sourceUrls = Array.isArray(gif.sourceUrls)
                ? gif.sourceUrls.map(cleanString).filter(Boolean)
                : [];

            return {
                src: cleanString(gif.src),
                url: cleanString(gif.url),
                ...(sourceUrls.length ? { sourceUrls } : {}),
                ...(typeof gif.width === "number" && Number.isFinite(gif.width) ? { width: gif.width } : {}),
                ...(typeof gif.height === "number" && Number.isFinite(gif.height) ? { height: gif.height } : {}),
            };
        })
        .filter(gif => gif.src !== "" || gif.url !== "");
}

function setHiddenGifs(hiddenGifs: HiddenGif[]) {
    settings.store.hiddenGifsJson = JSON.stringify(sanitizeHiddenGifs(hiddenGifs));
}

function getHiddenGifs(): HiddenGif[] {
    const { hiddenGifsJson, hiddenGifs } = settings.plain;
    if (typeof hiddenGifsJson === "string") {
        try {
            return sanitizeHiddenGifs(JSON.parse(hiddenGifsJson));
        } catch (error) {
            logger.error("Could not read saved hidden GIFs", error);
        }
    }
    return sanitizeHiddenGifs(hiddenGifs);
}

function migrateHiddenGifs() {
    const saved = getHiddenGifs();
    if (settings.plain.hiddenGifs !== undefined) {
        settings.store.hiddenGifs = sanitizeHiddenGifs(settings.plain.hiddenGifs);
    }
    setHiddenGifs(saved);
}

function toggleGif(gif: GifReference, hidden: boolean) {
    const current = getHiddenGifs();

    if (hidden) {
        if (current.some(item => sameGif(item, gif))) return;

        const src = cleanString(gif.src);
        const url = cleanString(gif.url);
        if (!src && !url) return;

        setHiddenGifs([
            ...current,
            {
                src,
                url,
                sourceUrls: gif.sourceUrls,
                width: typeof gif.width === "number" ? gif.width : undefined,
                height: typeof gif.height === "number" ? gif.height : undefined,
            },
        ]);
        return;
    }

    setHiddenGifs(current.filter(item => !sameGif(item, gif)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

const GIF_URL_FIELDS = [
    "src",
    "url",
    "link",
    "href",
    "itemSrc",
    "itemHref",
    "currentSrc",
    "originalSrc",
    "originalUrl",
    "proxyURL",
    "proxy_url",
];
const GIF_NESTED_FIELDS = ["item", "gif", "media", "image", "thumbnail"];

function collectGifUrls(value: unknown, depth = 0, seen = new Set<object>()): string[] {
    const record = asRecord(value);
    if (!record || seen.has(record)) return [];

    seen.add(record);
    const urls = GIF_URL_FIELDS.map(field => cleanString(record[field])).filter(Boolean);
    if (depth >= 2) return urls;

    return [
        ...urls,
        ...GIF_NESTED_FIELDS.flatMap(field => collectGifUrls(record[field], depth + 1, seen)),
    ];
}

function firstString(...values: unknown[]): string {
    for (const value of values) {
        const result = cleanString(value);
        if (result) return result;
    }

    return "";
}

function firstNumber(...values: unknown[]): number | undefined {
    return values.find((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function getTargetMediaUrl(value: unknown): string {
    if (!value || typeof value !== "object") return "";

    const target = value as HTMLElement & { currentSrc?: string; src?: string; };
    const direct = firstString(target.currentSrc, target.src);
    if (direct) return direct;

    if (typeof target.querySelector !== "function" || typeof target.matches !== "function") return "";

    const media = (target.matches("img,video")
        ? target
        : target.querySelector("img,video") ?? target.closest("[class*='imageWrapper']")?.querySelector("img,video")) as (HTMLImageElement | HTMLVideoElement | null);

    return firstString(media?.currentSrc, media?.src);
}

function getGifReference(props: unknown): GifReference | null {
    const record = asRecord(props);
    if (!record) return null;

    const item = asRecord(record.item);
    const gif = asRecord(record.gif);
    const target = asRecord(record.target);
    const targetMediaUrl = getTargetMediaUrl(record.target);
    const sourceUrls = [...new Set([
        ...collectGifUrls(record),
        targetMediaUrl,
    ].filter(Boolean))];
    const src = firstString(record.src, record.itemSrc, item?.src, gif?.src, target?.currentSrc, target?.src, targetMediaUrl);
    const url = firstString(record.link, record.url, record.href, record.itemHref, item?.link, item?.url, item?.href, gif?.link, gif?.url, gif?.href);
    if (!src && !url) return null;

    return {
        src: src || undefined,
        url: url || undefined,
        sourceUrls,
        width: firstNumber(record.width, item?.width, gif?.width),
        height: firstNumber(record.height, item?.height, gif?.height),
    };
}

function getGifLabel(gif: GifReference): string {
    const value = cleanString(gif.url) || cleanString(gif.src) || "Unknown GIF";

    try {
        const url = new URL(value);
        return `${url.hostname}${url.pathname}`;
    } catch {
        return value;
    }
}

function KeybindSettings() {
    const [isListening, setIsListening] = useState(false);
    const { keybind } = settings.use(KEYBIND_SETTINGS);

    useEffect(() => {
        if (!isListening) return;

        recordingKeybind = true;
        cancelRevealHide();
        pressedKeys.clear();
        visibility.store.revealed = false;

        const recordingModifiers: string[] = [];
        const activeModifiers = new Set<string>();
        const handleKeyDown = (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();

            const key = normalizeKey(event.key);
            if (isModifierKey(key)) {
                if (!recordingModifiers.includes(key)) recordingModifiers.push(key);
                activeModifiers.add(key);
                return;
            }

            settings.store.keybind = eventToKeybind(event);
            setIsListening(false);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            event.preventDefault();
            event.stopPropagation();

            const key = normalizeKey(event.key);
            if (!isModifierKey(key)) return;

            activeModifiers.delete(key);
            if (activeModifiers.size !== 0 || recordingModifiers.length === 0) return;

            settings.store.keybind = [...recordingModifiers];
            setIsListening(false);
        };

        const handleBlur = () => setIsListening(false);

        document.addEventListener("keydown", handleKeyDown, true);
        document.addEventListener("keyup", handleKeyUp, true);
        window.addEventListener("blur", handleBlur);

        return () => {
            recordingKeybind = false;
            pressedKeys.clear();
            document.removeEventListener("keydown", handleKeyDown, true);
            document.removeEventListener("keyup", handleKeyUp, true);
            window.removeEventListener("blur", handleBlur);
        };
    }, [isListening]);

    return (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => setIsListening(true)}
                disabled={isListening}
            >
                {isListening ? "Press the keys..." : formatKeybind(keybind)}
            </Button>
            <Button
                type="button"
                variant="secondary"
                size="small"
                onClick={() => {
                    settings.store.keybind = [...DEFAULT_KEYBIND];
                    syncRevealKeybind();
                }}
                disabled={isListening}
            >
                Reset
            </Button>
        </div>
    );
}

function HiddenGifsSettings() {
    const { hiddenGifsJson } = settings.use(HIDDEN_SETTINGS);
    const gifs = useMemo(getHiddenGifs, [hiddenGifsJson]);

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span>{gifs.length ? `${gifs.length} GIF${gifs.length === 1 ? "" : "s"} hidden` : "No GIFs hidden"}</span>
                <Button
                    type="button"
                    size="small"
                    variant="secondary"
                    disabled={!gifs.length}
                    onClick={() => setHiddenGifs([])}
                >
                    Show all
                </Button>
            </div>

            {gifs.length === 0 ? (
                <Paragraph>Right-click a GIF in the picker and choose “Hide from Favorites”. Hold the reveal keybind to temporarily show hidden GIFs again; they hide two seconds after you release it.</Paragraph>
            ) : (
                gifs.map((gif, index) => (
                    <div
                        key={`${getGifKeys(gif).join("|")}-${index}`}
                        style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
                    >
                        <span
                            title={gif.url || gif.src}
                            style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                            {getGifLabel(gif)}
                        </span>
                        <Button
                            type="button"
                            size="small"
                            variant="secondary"
                            onClick={() => toggleGif(gif, false)}
                        >
                            Show
                        </Button>
                    </div>
                ))
            )}
        </div>
    );
}

const settings = definePluginSettings({
    keybind: {
        type: OptionType.COMPONENT,
        description: "Hold this keybind to temporarily show GIFs hidden from Favorites. They hide two seconds after release. Alt is the default.",
        default: DEFAULT_KEYBIND,
        component: KeybindSettings,
    },
    manageHiddenGifs: {
        type: OptionType.COMPONENT,
        description: "Manage GIFs hidden from the Favorites category.",
        component: HiddenGifsSettings,
    },
}).withPrivateSettings<{ hiddenGifs?: HiddenGif[]; hiddenGifsJson?: string; keybindMigrationVersion?: number; }>();

const gifPickerContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    const gif = getGifReference(props);
    if (!gif || !getGifKeys(gif).length) return;

    const hidden = getHiddenGifs().some(item => sameGif(item, gif));
    const key = getGifKeys(gif).join("|");
    const group = findGroupChildrenByChildId(["copy-link", "gif-picker-copy-link"], children, true) ?? children;
    if (group.some(child => child?.props?.id === "hide-favorite-gif")) return;

    group.push(
        <Menu.MenuItem
            id="hide-favorite-gif"
            key={`hide-favorite-gif-${key}`}
            label={hidden ? "Show in Favorites" : "Hide from Favorites"}
            action={() => toggleGif(gif, !hidden)}
        />
    );
};

export default definePlugin({
    name: "HideFavoriteGIFs",
    description: "Hide selected GIFs from Favorites without unfavoriting them.",
    tags: ["Emotes", "Utility"],
    authors: [Devs.captain],
    settings,
    contextMenus: {
        "gif-picker": gifPickerContextMenuPatch,
    },
    patches: [
        {
            find: '.sortBy("order").reverse()',
            replacement: {
                match: /return (\i\.useMemo\(\(\)=>.{0,300}?\.sortBy\("order"\)\.reverse\(\).{0,150}?\.value\(\),\[[^\]]{0,80}\]\))/,
                replace: "return $self.useFilteredGifs($1)",
            },
        },
    ],
    start() {
        migrateHiddenGifs();
        migrateKeybind();
        cancelRevealHide();
        pressedKeys.clear();
        visibility.setData({ enabled: true, revealed: false });
        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("keyup", handleKeyUp, true);
        window.addEventListener("blur", clearPressedKeys);
    },
    stop() {
        window.removeEventListener("keydown", handleKeyDown, true);
        window.removeEventListener("keyup", handleKeyUp, true);
        window.removeEventListener("blur", clearPressedKeys);
        cancelRevealHide();
        pressedKeys.clear();
        recordingKeybind = false;
        visibility.setData({ enabled: false, revealed: false });
    },
    useFilteredGifs,
});
