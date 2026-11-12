<p align="center"><img src="app/logo.webp" width="150" alt="ST Card Creator logo"></p>
<p align="center"><img src="app/wordmark.webp" width="260" alt="ST Card Creator"></p>

<p align="center">Another <a href="https://docs.sillytavern.app">SillyTavern</a> cards Creator</p>

<p align="center"><a href="https://daddaiz.github.io/StCardCreator/"><b>Try it online</b></a> · <a href="https://github.com/Daddaiz/StCardCreator/releases/latest"><b>Download</b></a></p>

<p align="center"><img src="docs/data.png?v=5" width="900" alt="The Data page"></p>

## Features

**Write**
- Every SillyTavern field on one page. Live token counts, automatic drafts, undo for every AI action.
- 🪄 **Wand** on each field: rewrites your text for that field, with optional questions first. *Needs an API.*
- **AI-assisted generation**: describe the idea in any language, pick the fields, get them written one by one in English. *Needs an API.*
- **Lorebook**: import a lorebook JSON, or let the AI suggest entries from the description with proper names and focused trigger keywords
- **Consistency check**: finds accidental contradictions (ages, looks, names), `{{char}}`/`{{user}}` misuse and leftover text
- 💬 **Test chat**: talk to the card before exporting it, with the same prompt layout SillyTavern sends. Greetings to swipe, lorebook entries shown when they trigger, nothing saved. *Needs an API.*

**Design**
- Cover with image, name, tagline, fonts, frames, masks, and three palettes per color set taken from the image (with a shuffle button). A **Presets** menu gives five starting points (Default, Classic, Minimal, Gallery, Noir).
- Under the top buttons, a strip shows the card name, how complete the card is (%) and the token totals.
- Your own transparent PNG/WebP frames, saved in the browser.
- **Edit your PNG**: decorate a ready image without writing data.

**Images**
- Ready-to-paste image prompts for the character, the first-message scene and every alternate message
- **Image generation** from inside the app *Needs an API.*
 
**Import and export**
- Import a card PNG or JSON. Export a PNG with the data embedded (`chara` + `ccv3`), JSON V3 or V2, CHARX (RisuAI) or TavernAI V1.
- **Cards**: a gallery of your saved cards, in the browser. Cards that came from or went to SillyTavern are listed apart ("From SillyTavern") and marked "Needs updating" when they differ from the version in SillyTavern. *The comparison works in the .exe, with SillyTavern running.* After a successful Add or Update to SillyTavern, it asks if you want to remove the card from here, to avoid duplicates.

## Versions and features

| Feature | Exe | Html |
|---|:---:|:---:|
| Everything else (card editor, cover, import/export, AI tools, Test chat) | ✅ | ✅ |
| **SillyTavern cards**: open a card from SillyTavern | ✅ | ❌ |
| **Add / Update** a card in SillyTavern (including its linked lorebook) | ✅ | ❌ |
| Backup of the original card before the first update | ✅ | ❌ |
| Checkpoint download from the Images page | ✅ | ❌ (link opens the model page) |
