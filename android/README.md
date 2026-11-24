# Selected Text Translator · Android

Android 8.0（API 26）及以上可用。首次打开，在设置中填写服务地址、API Key 和模型，支持 OpenAI 兼容接口及阿里云百炼。使用 Qwen-MT 翻译时，引导理解需要另外配置通用学习模型。

在支持系统文字处理菜单的应用里长按选中文字，点「用 Selected 翻译」打开结果。也可以在系统分享菜单把文字发给 Selected，或打开 Selected 手动粘贴。翻译和引导理解共用原文。结果支持复制、朗读和收藏，返回后可以继续在原应用阅读。

外部划词交给应用的是选中的文字。需要结合完整语境时，可以选中整句或粘贴一段原文。模型请求发送原文到用户配置的服务。收藏保存在手机本地，API Key 使用 Android Keystore 管理的密钥加密。

## 安装预览版

在项目的 GitHub Releases 查找 `android-v*` 预发布版本，下载 APK。文件名以 `-preview.apk` 结尾时，安装的是「Selected 翻译预览版」，应用 ID 为 `io.github.selectedtext.translator.debug`。安装包使用 CI 生成的调试签名。不同构建机的调试签名可能不同，同包名且签名不同时，Android 要求先卸载旧包，卸载会清除本地应用数据。正式签名包的应用 ID 为 `io.github.selectedtext.translator`，独立安装并保存数据。

## 开发与验证

安装 JDK 17、Node.js 22 和 Android SDK Platform 36、Build Tools 36.0.0。设置 `ANDROID_HOME`，或由 Android Studio 配置本目录的 `local.properties`。

```bash
cd android
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

构建时从仓库根目录的 `src/` 生成模型请求模板并打包进 APK。单元测试使用模拟服务。

在设备上可验证 Chrome 网页划词、另一应用分享纯文本、粘贴中英文、翻译及引导、复制朗读和收藏。检查退出结果页后回到原应用，并在重新打开 Android 应用时核对收藏条目。

在 `app/build.gradle` 中更新 `versionName`，并递增 `versionCode`。发布标签使用 `android-v<version>`。CI 验证、打包并核对 APK 的签名与版本，随后发布带 SHA-256 校验文件的 GitHub 预发行版。


配置 GitHub Actions 的 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS` 和 `ANDROID_KEY_PASSWORD` 后，标签构建使用同一发布密钥签名，便于后续覆盖升级。这四项都留空时，发布使用调试签名的预览包。
