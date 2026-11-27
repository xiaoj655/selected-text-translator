import { text } from '@kit.ArkGraphics2D';

@Component
export struct ArticleParagraph {
  @Prop content: string = '';
  @Prop selectionStart: number = -1;
  @Prop selectionEnd: number = -1;
  onOffset: (offset: number, windowY: number) => void = () => {};
  private controller: TextController = new TextController();

  private selectAt(event: ClickEvent): void {
    const layout = this.controller.getLayoutManager();
    if (!layout) {
      return;
    }
    const context = this.getUIContext();
    const x = context.vp2px(event.x);
    const y = context.vp2px(event.y);
    const offset = layout.getGlyphPositionAtCoordinate(x, y).position;
    for (const candidate of [offset, offset - 1]) {
      if (candidate < 0 || candidate >= this.content.length || /\s/.test(this.content[candidate])) {
        continue;
      }
      const range: TextRange = { start: candidate, end: candidate + 1 };
      const boxes = layout.getRectsForRange(range, text.RectWidthStyle.TIGHT, text.RectHeightStyle.TIGHT);
      if (boxes.some((box: text.TextBox) => x >= box.rect.left && x <= box.rect.right &&
        y >= box.rect.top && y <= box.rect.bottom)) {
        this.onOffset(candidate, event.windowY);
        return;
      }
    }
  }

  build() {
    Text(undefined, { controller: this.controller }) {
      if (this.selectionStart >= 0 && this.selectionEnd > this.selectionStart) {
        Span(this.content.slice(0, this.selectionStart))
        Span(this.content.slice(this.selectionStart, this.selectionEnd))
          .textBackgroundStyle({ color: $r('app.color.reader_selection'), radius: 3 })
          .decoration({ type: TextDecorationType.Underline, color: $r('app.color.reader_accent') })
        Span(this.content.slice(this.selectionEnd))
      } else {
        Span(this.content)
      }
    }
    .width('100%')
    .fontSize(20)
    .lineHeight('32fp')
    .fontColor($r('app.color.reader_text'))
    .onClick((event: ClickEvent) => this.selectAt(event))
  }
}
