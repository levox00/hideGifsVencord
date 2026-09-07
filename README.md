# Hide Favorite GIFs

An Equicord/Vencord userplugin that hides selected GIFs from Discord's Favorites category without removing them from your favorites.

## Install

Copy this folder to:

```text
C:\Users\leand\Equicord\src\userplugins\hideFavoriteGIFs
```

Rebuild Equicord, restart Discord, and enable **HideFavoriteGIFs** in the plugin settings.

## Use

- Right-click a GIF in the GIF picker and choose **Hide from Favorites**.
- The GIF remains favorited and is removed only from the Favorites view.
- Hidden GIFs are saved in Equicord's settings and stay hidden after restarting Discord. Existing hidden entries migrate automatically.
- Hold **Alt** to temporarily reveal every hidden GIF in the already-open picker. They hide again two seconds after you release it, without closing or reopening the picker.
- Open the plugin settings to record a different reveal keybind, or use **Show** / **Show all** under the hidden-GIF manager to restore GIFs permanently.

After installing an update, fully restart Discord once to load the new patches. Temporary reveal state is never saved. This only filters the Favorites view; it does not hide GIFs in messages or search results.

## Regression tests

The tests use real React, Equicord's SettingsStore and settings hooks, and the native Discord Favorites module captured from the build identified in `tests/discord-favorites.mjs`. They exercise a mounted picker without changing its source favorites or remounting it, and simulate restart by serializing and reloading settings. They do not control a running Discord client.

Install isolated test-only dependencies and run from this plugin folder:

```powershell
$gifTestDir = Join-Path ([System.IO.Path]::GetTempPath()) ("equicord-gif-tests-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $gifTestDir | Out-Null
npm install --prefix $gifTestDir --no-audit --no-fund --ignore-scripts react@19.1.1 react-test-renderer@19.1.1 lodash@4.17.21
node tests/regression.test.mjs C:/Users/leand/Equicord $gifTestDir
```
