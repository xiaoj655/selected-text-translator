# Android 更新日志

## 0.2.18

- Vocabulary 学习卡片的单词发音遵循 **Settings → Speech** 的语音选择。选择 Alibaba Cloud 时使用云端语音，云端不可用时回退到系统语音。

## 0.2.17

- Open **Vocabulary** to learn new English words and review them offline. The app starts with a mix of difficulty levels and adjusts new words based on what you already know.
- English words you look up or save can influence suggestions. Vocabulary progress is saved on this device.

## 0.2.16

- When an article image returns HTTP 403, retry it once with the article's site origin when permitted. This also works for saved articles.

## 0.2.15

- E Ink mode uses the bottom of the screen for more article text. Use physical page keys or swipe the article to keep reading.

## 0.2.14

- In an article with E Ink mode enabled, use Page Up or Volume Up for the previous screen and Page Down or Volume Down for the next screen. This also supports e-reader side buttons that send these events.

## 0.2.13

- Turn on **Aa → E Ink mode** in an article for instant Previous screen and Next screen controls. The reader remembers the mode and your place in each article.
- E Ink mode uses static image loading indicators and opens the article menu without animation. Article scrolling skips the edge stretch and scrollbar fade.

## 0.2.12

- Enable Alibaba Cloud read-aloud in **Settings → Speech**. Choose a preset or enter a custom voice ID, then preview it in Settings. The app uses Android speech if cloud audio is unavailable.

## 0.2.11

- Reuse article images when scrolling back, with a bounded local image cache and memory usage sized to the device. Size decoded images to their display area to keep more photos in memory.
- Keep image loads running when they briefly leave the screen, so scrolling back shares the existing request instead of restarting it.

## 0.2.10

- Use the active Android VPN for reading requests, including VPNs that return temporary DNS addresses.
- Reload images from saved feed content when available. If direct import fails or returns no images, try a configured IQS connection. Keep saved text when recovering images from either fallback.

## 0.2.9

- Import the selected Psyche story with its paragraphs and inline images. Use **Aa → Reimport article** to replace an incomplete saved copy from the original page.
- Keep later sections when importing article content returned by Alibaba Cloud IQS.

## 0.2.8

- Show article images in Reading and retry images that fail to load. In older articles, use **Aa → Reload images** to load the original page and keep your reading position.

## 0.2.7

- Article lookups show the selected meaning first, with sentence explanations available on demand. Grammar highlights appear automatically, and the selected text stays underlined.
- Use Guided Reading in articles to see one hint at a time or reveal the answer immediately. Open the sentence explanation after revealing the answer.
- Phone and split-screen layouts use a compact, scrollable reading panel with fixed actions. Wide windows keep the side panel.

## 0.2.6

- Keep reading text and controls legible in Android dark mode.
- Preserve the reading position when switching between window sizes and orientations.
- Tap a word to look up its meaning and analyze the sentence structure in parallel.

## 0.2.5

- On wide screens, read the original text and translation or guided explanation side by side.
- Read articles in a comfortable-width column, with word and sentence explanations beside the text when there is room.
- Keep translation and reading usable in phone and split-screen windows, with a stacked layout and controls that fit the available space.

## 0.2.4

- Show or hide the model provider and Alibaba Cloud IQS API keys in Settings. Both start hidden.

## 0.2.3

- Keep the reading scrollbar steady and accurate as paragraphs of different lengths move through the viewport.

## 0.2.2

- See your place in an article with a slim scrollbar that appears while scrolling and fades when you stop.

## 0.2.1

- Switch between Translate, Reading, and Saved directly from the bottom navigation. The article view keeps the full screen for reading.
- Start a translation or a guided explanation from the text box. Read aloud, copy, and save next to the result.
- Scan Discover by headline and filter sources from a clearly marked menu.
- Article lookups put the meaning or plain-English paraphrase first. Expand grammar details when needed, with structure highlights in the article itself.

## 0.2.0

- Discover includes nine built-in reading sources shared with desktop. Add your own RSS or Atom feeds, filter by source, and revisit cached entries offline.
- Import web articles from links, browser shares, or feeds. An optional Alibaba Cloud IQS key enables enhanced parsing with direct import and pasted text available as fallbacks.
- Reading uses correct light and dark colors. Adjust text size, long-press to look up a phrase, and see sentence structure highlighted in the article.
- Model settings include a connection test and default to `qwen3.8-flash` for reading and guided explanations. The translation workspace accepts up to 50,000 characters.

## 0.1.4

- Open Reading to import an article from a shared browser link, paste a link, or add article text. Articles and reading position are saved on the device.
- Tap a word for its meaning in context or switch to Sentence for a plain-English paraphrase and color-coded grammar. Read selections aloud and save them to Saved expressions.
- The Android interface, settings, and update messages now use English.

## 0.1.3

- 正式签名版打开工作台时自动检查更新，设置页也可手动检查。下载后通过 Android 安装界面确认覆盖安装。
- 发布流水线为正式签名 APK 附带更新信息。应用下载后核对文件完整性、版本、包名和签名。
- Android 发布流水线统一产出正式签名 APK。

## 0.1.2

- 更新翻译工作台、划词面板、模型设置和表达本的浅色与深色样式。
- 划词面板贴合屏幕底部，朗读、复制和收藏集中在同一行。
- 使用双对话气泡的 Android 自适应应用图标，支持系统主题色。

## 0.1.1

- 在 GitHub Actions 中显式安装 Android SDK 工具和 API 36 组件，恢复预览 APK 自动发布。

## 0.1.0

- 从 Android 划词菜单、系统分享或应用内粘贴打开翻译。
- 支持直接翻译、引导理解、复制、系统朗读及本地收藏。
- 支持连接自有 OpenAI 兼容模型服务，API Key 加密存储。
- 提供可安装的 Android 预览 APK 和 SHA-256 校验文件。
