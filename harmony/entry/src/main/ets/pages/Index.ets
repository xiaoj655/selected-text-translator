import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { ArticleParagraph } from '../reader/ArticleParagraph';
import {
  ReaderArticle, ReaderLibraryEntry, ReaderParagraph, ReaderSelection, ReaderSelectionKind,
  clampReaderParagraphIndex, parseReaderArticle, resolveReaderSelection
} from '../reader/ReaderDomain';
import {
  ReaderExplanation, ReaderLookupOperation, ReaderModelSettings, defaultReaderModelSettings, startReaderLookup,
  validateReaderModelSettings
} from '../services/ReaderModel';
import { ReaderStore } from '../services/ReaderStore';

const SAMPLE = `On an ordinary walk, most of what we see is familiar. We pass the same buildings and cross the same streets, so our attention begins to drift. But when we look a little closer, the familiar can become surprisingly rich.

Try choosing one thing to pay attention to: the shape of each doorway, the sound of footsteps, or the places where plants break through the pavement. A small question can turn a routine walk into an observation exercise.

You don't have to remember every detail. Notice one thing you would normally overlook, and describe it in your own words. Over time, this simple habit can change what you see.`;

@Entry
@Component
struct Index {
  @State page: string = 'library';
  @State entries: ReaderLibraryEntry[] = [];
  @State libraryReady: boolean = false;
  @State libraryError: string = '';
  @State modelReady: boolean = false;
  @State modelConfigured: boolean = false;
  @State settingsError: string = '';
  @State readerNotice: string = '';
  @State windowWidth: number = 0;
  @State windowHeight: number = 0;
  @State article: ReaderArticle | null = null;
  @State initialParagraph: number = 0;
  @State pastedTitle: string = '';
  @State pastedText: string = '';
  @State importError: string = '';
  @State importing: boolean = false;
  @State deletingArticle: boolean = false;
  @State libraryNotice: string = '';
  @State draftBaseUrl: string = '';
  @State draftApiKey: string = '';
  @State draftModel: string = '';
  @State savingSettings: boolean = false;
  @State mode: ReaderSelectionKind = 'word';
  @State selectedParagraph: number = -1;
  @State selection: ReaderSelection | null = null;
  @State result: ReaderExplanation | null = null;
  @State loadingLookup: boolean = false;
  @State lookupError: string = '';

  private store: ReaderStore | null = null;
  private settings: ReaderModelSettings = defaultReaderModelSettings();
  private settingsReturn: string = 'library';
  private scroller: Scroller = new Scroller();
  private revision: number = 0;
  private activeLookup: ReaderLookupOperation | null = null;
  private progressTimer: number = -1;
  private progressDirty: boolean = false;
  private readingIndex: number = 0;
  private revealWindowY: number = -1;
  private foreground: boolean = true;

  aboutToAppear(): void {
    const host = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.store = new ReaderStore(host);
    this.loadLibrary();
    this.loadSettings();
  }

  onPageShow(): void {
    this.foreground = true;
  }

  onPageHide(): void {
    this.foreground = false;
    this.flushProgress();
  }

  onBackPress(): boolean {
    if (this.page === 'library') {
      return false;
    }
    this.back();
    return true;
  }

  private async loadLibrary(): Promise<void> {
    this.libraryError = '';
    try {
      if (this.store) {
        this.entries = await this.store.loadLibrary();
        this.libraryReady = true;
      }
    } catch (_) {
      this.libraryError = '暂时无法读取书架，请重试。';
    }
  }

  private async loadSettings(): Promise<void> {
    try {
      if (this.store) {
        this.settings = await this.store.loadModelSettings();
        this.modelConfigured = this.settings.apiKey.length > 0;
        if (this.page === 'reader' && this.selection && this.modelConfigured) {
          this.requestLookup(this.selection);
        }
      }
    } catch (error) {
      this.settingsError = error instanceof Error ? error.message : '无法读取模型配置，请重试。';
    } finally {
      this.modelReady = true;
    }
  }

  private persist(entries: ReaderLibraryEntry[]): Promise<void> {
    const store = this.store;
    if (!store) {
      return Promise.reject(new Error('书架尚未准备好。'));
    }
    return store.saveLibrary(entries);
  }

  private async importArticle(value: string, title: string): Promise<void> {
    if (!this.libraryReady || this.importing) {
      return;
    }
    const article = parseReaderArticle(value, util.generateRandomUUID(), title);
    if (!article) {
      this.importError = '请先粘贴文章正文。';
      return;
    }
    this.importing = true;
    this.importError = '';
    const entry: ReaderLibraryEntry = { article, paragraphIndex: 0 };
    const next = [entry, ...this.entries];
    try {
      await this.persist(next);
      this.entries = next;
      this.pastedText = '';
      this.pastedTitle = '';
      this.openArticle(entry);
    } catch (_) {
      this.importError = '文章保存失败，请重试。';
    } finally {
      this.importing = false;
    }
  }

  private async removeArticle(entry: ReaderLibraryEntry): Promise<void> {
    if (this.deletingArticle || this.importing) {
      return;
    }
    this.deletingArticle = true;
    this.libraryNotice = '';
    try {
      const choice = await this.getUIContext().getPromptAction().showDialog({
        title: '删除文章？',
        message: entry.article.title,
        buttons: [
          { text: '取消', color: '' },
          { text: '删除', color: '#B43C34' }
        ]
      });
      if (choice.index === 1) {
        const next = this.entries.filter((item: ReaderLibraryEntry) => item.article.id !== entry.article.id);
        try {
          await this.persist(next);
          this.entries = next;
        } catch (_) {
          this.libraryNotice = '文章删除失败，请重试。';
        }
      }
    } catch (_) {
      // Dismissing the confirmation also cancels the deletion.
    } finally {
      this.deletingArticle = false;
    }
  }

  private openArticle(entry: ReaderLibraryEntry): void {
    this.clearLookup();
    this.readerNotice = '';
    this.article = entry.article;
    this.readingIndex = clampReaderParagraphIndex(entry.article, entry.paragraphIndex);
    this.initialParagraph = this.readingIndex;
    this.mode = 'word';
    this.page = 'reader';
  }

  private noteProgress(index: number): void {
    const article = this.article;
    if (!article || this.page !== 'reader' || !this.foreground || index < 0) {
      return;
    }
    const paragraphIndex = clampReaderParagraphIndex(article, index);
    if (this.readingIndex === paragraphIndex) {
      return;
    }
    this.readingIndex = paragraphIndex;
    this.entries = this.entries.map((entry: ReaderLibraryEntry): ReaderLibraryEntry => {
      return entry.article.id === article.id ? { article: entry.article, paragraphIndex } : entry;
    });
    this.progressDirty = true;
    clearTimeout(this.progressTimer);
    this.progressTimer = setTimeout(() => this.flushProgress(), 350);
  }

  private flushProgress(): void {
    clearTimeout(this.progressTimer);
    if (!this.progressDirty) {
      return;
    }
    this.progressDirty = false;
    this.persist(this.entries).catch(() => {
      if (this.page === 'reader') {
        this.readerNotice = '阅读进度保存失败，继续滚动后会重试。';
      }
    });
  }

  private back(): void {
    if (this.importing || this.savingSettings) {
      return;
    }
    if (this.page === 'settings') {
      this.draftApiKey = '';
      this.page = this.settingsReturn;
      return;
    }
    if (this.page === 'reader') {
      this.flushProgress();
      this.clearLookup();
      this.article = null;
    }
    this.importError = '';
    this.page = 'library';
  }

  private openSettings(): void {
    if (!this.modelReady) {
      return;
    }
    if (this.page === 'reader') {
      this.flushProgress();
      this.initialParagraph = this.readingIndex;
    }
    this.settingsReturn = this.page;
    this.draftBaseUrl = this.settings.baseUrl;
    this.draftApiKey = this.settings.apiKey;
    this.draftModel = this.settings.model;
    this.page = 'settings';
  }

  private async saveSettings(): Promise<void> {
    if (this.savingSettings || !this.store) {
      return;
    }
    this.settingsError = '';
    const draft: ReaderModelSettings = {
      baseUrl: this.draftBaseUrl, apiKey: this.draftApiKey, model: this.draftModel
    };
    let next: ReaderModelSettings;
    try {
      next = validateReaderModelSettings(draft, false);
    } catch (error) {
      this.settingsError = error instanceof Error ? error.message : '请检查模型配置。';
      return;
    }
    this.savingSettings = true;
    try {
      await this.store.saveModelSettings(next);
      this.settings = next;
      this.modelConfigured = next.apiKey.length > 0;
      this.draftApiKey = '';
      this.page = this.settingsReturn;
      const selection = this.selection;
      if (this.page === 'reader' && selection) {
        this.requestLookup(selection);
      }
    } catch (error) {
      this.settingsError = error instanceof Error ? error.message : '无法保存模型配置，请重试。';
    } finally {
      this.savingSettings = false;
    }
  }

  private clearLookup(): void {
    this.revision++;
    this.activeLookup?.cancel();
    this.activeLookup = null;
    this.selectedParagraph = -1;
    this.selection = null;
    this.result = null;
    this.loadingLookup = false;
    this.lookupError = '';
    this.revealWindowY = -1;
  }

  private changeMode(mode: ReaderSelectionKind): void {
    if (this.mode !== mode) {
      this.mode = mode;
      this.clearLookup();
    }
  }

  private selectAt(paragraph: ReaderParagraph, index: number, offset: number, windowY: number): void {
    const selection = resolveReaderSelection(paragraph.text, offset, this.mode);
    if (!selection) {
      return;
    }
    if (this.selectedParagraph === index && this.selection?.start === selection.start &&
      this.selection?.end === selection.end) {
      return;
    }
    this.revealWindowY = !this.isWide() && !this.selection ? windowY : -1;
    this.selectedParagraph = index;
    this.selection = selection;
    this.requestLookup(selection);
  }

  private showSentence(): void {
    const article = this.article;
    const selected = this.selection;
    if (article && selected && this.selectedParagraph >= 0) {
      const paragraph = article.paragraphs[this.selectedParagraph];
      const sentence = resolveReaderSelection(paragraph.text, selected.start, 'sentence');
      if (sentence) {
        this.mode = 'sentence';
        this.selection = sentence;
        this.requestLookup(sentence);
      }
    }
  }

  private async requestLookup(selection: ReaderSelection): Promise<void> {
    const revision = ++this.revision;
    this.activeLookup?.cancel();
    this.activeLookup = null;
    this.result = null;
    this.lookupError = '';
    this.loadingLookup = false;
    if (!this.modelConfigured) {
      return;
    }
    this.loadingLookup = true;
    try {
      const operation = startReaderLookup(this.settings, selection);
      this.activeLookup = operation;
      const result = await operation.result;
      if (this.revision === revision) {
        this.result = result;
      }
    } catch (error) {
      if (this.revision === revision) {
        this.lookupError = error instanceof Error ? error.message : '查询失败，请重试。';
      }
    } finally {
      if (this.revision === revision) {
        this.activeLookup = null;
        this.loadingLookup = false;
      }
    }
  }

  private isWide(): boolean {
    return this.windowWidth >= 840 && this.windowWidth > this.windowHeight;
  }

  private actionPadding(): number {
    return this.windowWidth >= 600 ? 28 : 16;
  }

  @Builder
  private toolbar(title: string, showBack: boolean) {
    Row({ space: 12 }) {
      if (showBack) {
        Button('返回', { type: ButtonType.Normal })
          .height(38)
          .borderRadius(8)
          .backgroundColor(Color.Transparent)
          .fontColor($r('app.color.reader_accent'))
          .onClick(() => this.back())
      }
      Text(title)
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('app.color.reader_text'))
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .maxLines(1)
        .layoutWeight(1)
      if (this.page === 'library' || this.page === 'reader') {
        Button('模型设置', { type: ButtonType.Normal })
          .height(38)
          .borderRadius(8)
          .backgroundColor(Color.Transparent)
          .fontColor($r('app.color.reader_secondary'))
          .enabled(this.modelReady && !this.importing && !this.deletingArticle)
          .onClick(() => this.openSettings())
      }
    }
    .width('100%')
    .height(56)
    .padding({ left: this.actionPadding(), right: this.actionPadding() })
    .border({ width: { bottom: 1 }, color: $r('app.color.reader_border') })
  }

  @Builder
  private library() {
    this.toolbar('Selected', false)
    Column({ space: 22 }) {
      Row({ space: 12 }) {
        Text('我的文章')
          .fontSize(30)
          .fontWeight(FontWeight.Bold)
          .fontColor($r('app.color.reader_text'))
          .layoutWeight(1)
        Button('添加文章', { type: ButtonType.Normal })
          .height(42)
          .borderRadius(9)
          .backgroundColor($r('app.color.reader_accent'))
          .fontColor($r('app.color.reader_on_accent'))
          .enabled(this.libraryReady && !this.importing && !this.deletingArticle)
          .onClick(() => { this.page = 'import'; })
      }
      .width('100%')
      if (this.libraryNotice) {
        Text(this.libraryNotice).fontColor($r('app.color.reader_secondary'))
      }
      if (this.libraryError) {
        Text(this.libraryError).fontColor($r('app.color.reader_secondary'))
        Button('重试').onClick(() => this.loadLibrary())
      } else if (!this.libraryReady) {
        LoadingProgress().height(26).width(26).color($r('app.color.reader_accent'))
      } else if (!this.entries.length) {
        Text('粘贴一篇英文文章，阅读时轻点单词或句子即可查释义。')
          .fontSize(16)
          .fontColor($r('app.color.reader_secondary'))
        Button('试读示例')
          .backgroundColor($r('app.color.reader_selection'))
          .fontColor($r('app.color.reader_accent'))
          .enabled(!this.importing)
          .onClick(() => this.importArticle(SAMPLE, 'How to notice more'))
        if (this.importError) {
          Text(this.importError).fontColor($r('app.color.reader_secondary'))
        }
      } else {
        List() {
          ForEach(this.entries, (entry: ReaderLibraryEntry) => {
            ListItem() {
              Row({ space: 12 }) {
                Column({ space: 6 }) {
                  Text(entry.article.title)
                    .fontSize(18)
                    .fontWeight(FontWeight.Medium)
                    .fontColor($r('app.color.reader_text'))
                    .maxLines(2)
                    .textOverflow({ overflow: TextOverflow.Ellipsis })
                  Text(`第 ${entry.paragraphIndex + 1} 段 / 共 ${entry.article.paragraphs.length} 段`)
                    .fontSize(13)
                    .fontColor($r('app.color.reader_secondary'))
                }
                .layoutWeight(1)
                .padding({ top: 16, bottom: 16 })
                .alignItems(HorizontalAlign.Start)
                .onClick(() => {
                  if (!this.deletingArticle) {
                    this.openArticle(entry);
                  }
                })
                Button('删除', { type: ButtonType.Normal })
                  .borderRadius(8)
                  .backgroundColor(Color.Transparent)
                  .fontColor($r('app.color.reader_secondary'))
                  .enabled(!this.deletingArticle)
                  .onClick(() => this.removeArticle(entry))
              }
              .width('100%')
            }
          }, (entry: ReaderLibraryEntry) => `${entry.article.id}:${entry.paragraphIndex}`)
        }
        .width('100%')
        .layoutWeight(1)
        .divider({ strokeWidth: 1, color: $r('app.color.reader_border') })
      }
    }
    .width('100%')
    .constraintSize({ maxWidth: 744 })
    .padding({ top: 30, bottom: 16, left: this.actionPadding(), right: this.actionPadding() })
    .alignItems(HorizontalAlign.Start)
    .layoutWeight(1)
  }

  @Builder
  private importPage() {
    this.toolbar('添加文章', true)
    Column({ space: 14 }) {
      TextInput({ placeholder: '标题（可选）', text: this.pastedTitle })
        .width('100%')
        .fontSize(17)
        .fontColor($r('app.color.reader_text'))
        .backgroundColor($r('app.color.reader_surface'))
        .maxLength(64)
        .onChange((value: string) => { this.pastedTitle = value; })
      TextArea({ placeholder: '在此粘贴英文正文', text: this.pastedText })
        .width('100%')
        .layoutWeight(1)
        .fontSize(17)
        .fontColor($r('app.color.reader_text'))
        .placeholderColor($r('app.color.reader_secondary'))
        .backgroundColor($r('app.color.reader_surface'))
        .border({ width: 1, color: $r('app.color.reader_border'), radius: 12 })
        .maxLength(100000)
        .onChange((value: string) => { this.pastedText = value; })
      if (this.importError) {
        Text(this.importError).fontColor($r('app.color.reader_secondary'))
      }
      Button(this.importing ? '正在保存…' : '保存并阅读', { type: ButtonType.Normal })
        .height(44)
        .borderRadius(9)
        .backgroundColor($r('app.color.reader_accent'))
        .fontColor($r('app.color.reader_on_accent'))
        .enabled(!this.importing && this.pastedText.trim().length > 0)
        .onClick(() => this.importArticle(this.pastedText, this.pastedTitle))
    }
    .width('100%')
    .constraintSize({ maxWidth: 744 })
    .padding({ top: 24, bottom: 24, left: this.actionPadding(), right: this.actionPadding() })
    .alignItems(HorizontalAlign.Start)
    .layoutWeight(1)
  }

  @Builder
  private settingsPage() {
    this.toolbar('模型设置', true)
    Scroll() {
      Column({ space: 12 }) {
        Text('输入 OpenAI 兼容服务地址和模型。查询会把选中的内容及所在句子发送给该服务。')
          .fontSize(15)
          .fontColor($r('app.color.reader_secondary'))
        Text('服务地址').fontSize(15).fontColor($r('app.color.reader_text'))
        TextInput({ text: this.draftBaseUrl, placeholder: 'https://…/v1' })
          .fontColor($r('app.color.reader_text'))
          .backgroundColor($r('app.color.reader_surface'))
          .type(InputType.URL)
          .onChange((value: string) => { this.draftBaseUrl = value; })
        Text('模型名称').fontSize(15).fontColor($r('app.color.reader_text'))
        TextInput({ text: this.draftModel, placeholder: 'qwen3.8-flash' })
          .fontColor($r('app.color.reader_text'))
          .backgroundColor($r('app.color.reader_surface'))
          .onChange((value: string) => { this.draftModel = value; })
        Text('API Key').fontSize(15).fontColor($r('app.color.reader_text'))
        TextInput({ text: this.draftApiKey, placeholder: '输入服务的 API Key' })
          .type(InputType.Password)
          .fontColor($r('app.color.reader_text'))
          .backgroundColor($r('app.color.reader_surface'))
          .onChange((value: string) => { this.draftApiKey = value; })
        if (this.settingsError) {
          Text(this.settingsError).fontColor($r('app.color.reader_secondary'))
        }
        Button(this.savingSettings ? '正在保存…' : '保存设置', { type: ButtonType.Normal })
          .height(44)
          .borderRadius(9)
          .backgroundColor($r('app.color.reader_accent'))
          .fontColor($r('app.color.reader_on_accent'))
          .enabled(!this.savingSettings)
          .onClick(() => this.saveSettings())
      }
      .width('100%')
      .padding({ top: 24, bottom: 28, left: this.actionPadding(), right: this.actionPadding() })
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .constraintSize({ maxWidth: 584 })
    .layoutWeight(1)
  }

  @Builder
  private modeButton(label: string, mode: ReaderSelectionKind) {
    Button(label, { type: ButtonType.Normal })
      .height(36)
      .borderRadius(8)
      .fontSize(14)
      .fontColor(this.mode === mode ? $r('app.color.reader_accent') : $r('app.color.reader_secondary'))
      .backgroundColor(this.mode === mode ? $r('app.color.reader_selection') : Color.Transparent)
      .onClick(() => this.changeMode(mode))
  }

  @Builder
  private articleReader(article: ReaderArticle) {
    this.toolbar('阅读', true)
    Row() {
      Column() {
        Row({ space: 12 }) {
          Text(article.title)
            .fontSize(20)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.reader_text'))
            .layoutWeight(1)
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Row({ space: 4 }) {
            this.modeButton('查词', 'word')
            this.modeButton('查句', 'sentence')
          }
        }
        .width('100%')
        .constraintSize({ maxWidth: 744 })
        .padding({ top: 12, bottom: 8, left: this.actionPadding(), right: this.actionPadding() })
        if (this.readerNotice) {
          Text(this.readerNotice)
            .fontSize(13)
            .fontColor($r('app.color.reader_secondary'))
            .padding({ left: this.actionPadding(), right: this.actionPadding(), bottom: 8 })
        }
        List({ scroller: this.scroller, initialIndex: this.initialParagraph, space: 20 }) {
          ForEach(article.paragraphs, (paragraph: ReaderParagraph, index: number) => {
            ListItem() {
              ArticleParagraph({
                content: paragraph.text,
                selectionStart: this.selectedParagraph === index ? this.selection?.start ?? -1 : -1,
                selectionEnd: this.selectedParagraph === index ? this.selection?.end ?? -1 : -1,
                onOffset: (offset: number, windowY: number) => this.selectAt(paragraph, index, offset, windowY)
              })
            }
          }, (paragraph: ReaderParagraph) => paragraph.id)
        }
        .width('100%')
        .constraintSize({ maxWidth: 744 })
        .layoutWeight(1)
        .padding({ top: 12, bottom: 28, left: this.actionPadding(), right: this.actionPadding() })
        .scrollBar(BarState.Auto)
        .onScrollIndex((start: number) => this.noteProgress(start))
        .onAreaChange((_previous: Area, area: Area) => {
          if (this.revealWindowY >= 0 && !this.isWide()) {
            const hidden = this.revealWindowY + 34 - Number(area.globalPosition.y) - Number(area.height);
            this.revealWindowY = -1;
            if (hidden > 0) {
              this.scroller.scrollBy(0, hidden);
            }
          }
        })
        if (!this.isWide() && this.selection) {
          Column() {
            this.resultPanel()
          }
          .width('100%')
          .height(Math.min(280, this.windowHeight * 0.38))
          .backgroundColor($r('app.color.reader_surface'))
          .border({ width: { top: 1 }, color: $r('app.color.reader_border') })
        }
      }
      .height('100%')
      .layoutWeight(1)
      if (this.isWide()) {
        Column() {
          this.resultPanel()
        }
        .height('100%')
        .width(this.windowWidth >= 1100 ? 348 : 300)
        .backgroundColor($r('app.color.reader_surface'))
        .border({ width: { left: 1 }, color: $r('app.color.reader_border') })
      }
    }
    .width('100%')
    .layoutWeight(1)
  }

  @Builder
  private resultPanel() {
    if (!this.selection) {
      Text(this.mode === 'word' ? '轻点正文中的单词查看释义。' : '轻点正文中的句子查看解读。')
        .fontSize(15)
        .fontColor($r('app.color.reader_secondary'))
        .width('100%')
        .padding(24)
    } else {
      Row({ space: 8 }) {
        Text(this.selection.kind === 'word' ? '单词释义' : '句子解读')
          .fontWeight(FontWeight.Medium)
          .fontColor($r('app.color.reader_text'))
          .layoutWeight(1)
        Button('关闭', { type: ButtonType.Normal })
          .height(34)
          .borderRadius(8)
          .backgroundColor(Color.Transparent)
          .fontColor($r('app.color.reader_secondary'))
          .onClick(() => this.clearLookup())
      }
      .width('100%')
      .padding({ left: 20, right: 14, top: 6 })
      Scroll() {
        Column({ space: 10 }) {
          Text(this.selection.text)
            .width('100%')
            .fontSize(this.selection.kind === 'word' ? 24 : 18)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.reader_text'))
          if (!this.modelConfigured) {
            Text('配置模型后即可查询释义。').fontColor($r('app.color.reader_secondary'))
            Button('配置模型')
              .backgroundColor($r('app.color.reader_selection'))
              .fontColor($r('app.color.reader_accent'))
              .enabled(this.modelReady)
              .onClick(() => this.openSettings())
          } else if (this.loadingLookup) {
            Row({ space: 8 }) {
              LoadingProgress().width(22).height(22).color($r('app.color.reader_accent'))
              Text('正在查询…').fontColor($r('app.color.reader_secondary'))
            }
          } else if (this.lookupError) {
            Text(this.lookupError).fontColor($r('app.color.reader_secondary'))
            Button('重试')
              .backgroundColor($r('app.color.reader_selection'))
              .fontColor($r('app.color.reader_accent'))
              .onClick(() => {
                if (this.selection) {
                  this.requestLookup(this.selection);
                }
              })
          } else if (this.result) {
            if (this.result.phonetic) {
              Text(this.result.phonetic).fontSize(15).fontColor($r('app.color.reader_secondary'))
            }
            Text(this.result.meaning)
              .fontSize(17)
              .lineHeight('26fp')
              .fontColor($r('app.color.reader_text'))
              .copyOption(CopyOptions.LocalDevice)
            if (this.result.contextualAnalysis) {
              Text(this.result.contextualAnalysis)
                .fontSize(15)
                .lineHeight('23fp')
                .fontColor($r('app.color.reader_secondary'))
            }
          }
          if (this.selection.kind === 'word') {
            Button('查看整句', { type: ButtonType.Normal })
              .height(38)
              .borderRadius(8)
              .backgroundColor($r('app.color.reader_selection'))
              .fontColor($r('app.color.reader_accent'))
              .onClick(() => this.showSentence())
          }
        }
        .width('100%')
        .padding({ left: 20, right: 20, top: 8, bottom: 18 })
        .alignItems(HorizontalAlign.Start)
      }
      .width('100%')
      .layoutWeight(1)
    }
  }

  build() {
    Column() {
      if (this.page === 'import') {
        this.importPage()
      } else if (this.page === 'settings') {
        this.settingsPage()
      } else if (this.page === 'reader' && this.article) {
        this.articleReader(this.article)
      } else {
        this.library()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.reader_background'))
    .onAreaChange((_previous: Area, area: Area) => {
      this.windowWidth = Number(area.width);
      this.windowHeight = Number(area.height);
    })
  }
}
