# NRK English Subtitles

A Chrome extension that automatically translates Norwegian subtitles on [NRK TV](https://tv.nrk.no) into English.

## Installation

Chrome does not allow extensions from outside the Web Store to be installed permanently, but you can load it as an unpacked extension for personal use:

1. Clone or download this repository.
2. Go to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top right).
4. Click **Load unpacked** and select the repository folder.
5. Open any episode on [tv.nrk.no](https://tv.nrk.no) and the extension will activate automatically.

## Permissions

| Permission | Purpose |
|---|---|
| `psapi.nrk.no` | Fetch the subtitle file URL from NRK's playback API |
| `undertekst.nrk.no` | Download the VTT subtitle file |
| `translate.googleapis.com` | Translate cues via Google Translate |

No data is stored or sent anywhere beyond what is listed above.

## Limitations

- Subtitles must be available on NRK's servers for the episode. Not all content has subtitles.
- Translation quality depends on Google Translate capabilities can be substituted by others e.g. LLMs.
- The extension is only tested on Chromium-based browsers.
