# Selected Text Translator · Android

Android 8.0（API 26）及以上可用。首次打开，在设置中填写服务地址、API Key 和模型，支持 OpenAI 兼容接口及阿里云百炼。使用 Qwen-MT 翻译时，引导理解需要另外配置通用学习模型。

在支持系统文字处理菜单的应用里长按选中文字，点「用 Selected 翻译」打开结果。也可以在系统分享菜单把文字发给 Selected，或打开 Selected 手动粘贴。翻译和引导理解共用原文。结果支持复制、朗读和收藏，返回后可以继续在原应用阅读。

外部划词交给应用的是选中的文字。需要结合完整语境时，可以选中整句或粘贴一段原文。模型请求发送原文到用户配置的服务。收藏保存在手机本地，API Key 使用 Android Keystore 管理的密钥加密。

## Reading

Open **Reading → Discover** to browse the built-in sources. Use the source menu to add a public HTTPS RSS or Atom feed. Saved articles and reading positions are available offline under **My articles**.

Share a public HTTPS article from your browser to **Selected**, or open **Reading → Add article** to paste a link, Markdown link, or article text. You can save an Alibaba Cloud IQS API key under **Settings → Reading** for enhanced web parsing. Selected encrypts the key on the phone. With a key set, web import sends the article URL to Alibaba Cloud. Charges may apply. If parsing fails, retry or use **Try direct import**.

In **Word** mode, tap a word to see its English meaning in that sentence. Long-press a word and tap the other end of a phrase, then choose **Look up**. Use **Analyze sentence** or switch to **Sentence** mode and tap anywhere in a sentence for its plain-English paraphrase and grammar. Valid grammar markup appears in the article and the result stays below it. Use **Aa** to change reading size, the speaker to hear the selection, or the bookmark to keep it in **Saved expressions**.

Word and sentence explanations use the learning model in **Settings → Models**, which defaults to `qwen3.8-flash`. Use **Test connection** to check the configured models. The app sends the selected text and relevant sentence to the configured model provider when you look it up. The translation workspace accepts up to 50,000 characters and processes long inputs in order.

## 安装与更新

首次安装时，在项目的 GitHub Releases 打开 `android-v*` 正式发布，下载 `selected-text-translator-android-<version>.apk`。正式版的应用 ID 为 `io.github.selectedtext.translator`。此前安装的预览版使用独立应用 ID，其设置和收藏依然保留在旧应用中。

打开正式版工作台时，应用会自动检查 GitHub Releases。确认已是最新版本后，间隔 24 小时再自动检查。设置页可随时手动检查。发现新版本后，点 **Download update**。校验完成后点 **Install update**，在 Android 安装界面确认覆盖安装。首次可能需要在 Android 设置中允许 Selected 安装应用。

## 开发与验证

安装 JDK 17、Node.js 22 和 Android SDK Platform 36、Build Tools 36.0.0。设置 `ANDROID_HOME`，或由 Android Studio 配置本目录的 `local.properties`。

```bash
cd android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

构建时从仓库根目录的 `src/` 生成模型请求模板并打包进 APK。单元测试使用模拟服务。

在设备上可验证 Chrome 网页划词、另一应用分享纯文本、粘贴中英文、翻译及引导、复制朗读和收藏。检查退出结果页后回到原应用，并在重新打开 Android 应用时核对收藏条目。

在 `app/build.gradle` 中更新 `versionName`，并递增 `versionCode`。发布标签使用 `android-v<version>`。CI 发布正式签名 APK、SHA-256 校验文件和应用内更新使用的 `update.json`。

首次发布前，在 GitHub 仓库的 Actions secrets 中配置 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` 和 `ANDROID_KEY_PASSWORD`。后续发布应沿用同一 Android 签名密钥，才能覆盖升级。
