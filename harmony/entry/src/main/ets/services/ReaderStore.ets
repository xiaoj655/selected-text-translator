import { common } from '@kit.AbilityKit'
import { util } from '@kit.ArkTS'
import { asset } from '@kit.AssetStoreKit'
import { BusinessError } from '@kit.BasicServicesKit'
import { fileIo } from '@kit.CoreFileKit'
import { clampReaderParagraphIndex, ReaderLibraryEntry } from '../reader/ReaderDomain'
import { defaultReaderModelSettings, ReaderModelSettings, validateReaderModelSettings } from './ReaderModel'

const FILE_NOT_FOUND = 13900002
const MAX_SETTINGS_BYTES = 1024
const SETTINGS_ALIAS = 'selected-reader-model-settings-v1'

export class ReaderStore {
  private readonly libraryPath: string
  private readonly encoder: util.TextEncoder = util.TextEncoder.create('utf-8')
  private libraryWrites: Promise<void> = Promise.resolve()
  private settingsWrites: Promise<void> = Promise.resolve()

  constructor(context: common.UIAbilityContext) {
    this.libraryPath = `${context.filesDir}/reader-library-v1.json`
  }

  async loadLibrary(): Promise<ReaderLibraryEntry[]> {
    await this.libraryWrites
    try {
      if (!(await fileIo.access(this.libraryPath))) return []
      const text = await fileIo.readText(this.libraryPath)
      const entries = JSON.parse(text) as ReaderLibraryEntry[]
      if (!Array.isArray(entries)) throw new Error('Invalid article library')
      for (const entry of entries) {
        if (typeof entry.article?.id !== 'string' || typeof entry.article.title !== 'string' ||
          !Array.isArray(entry.article.paragraphs) || entry.article.paragraphs.length === 0) {
          throw new Error('Invalid saved article')
        }
        for (const paragraph of entry.article.paragraphs) {
          if (typeof paragraph.id !== 'string' || typeof paragraph.text !== 'string') {
            throw new Error('Invalid saved paragraph')
          }
        }
        entry.paragraphIndex = clampReaderParagraphIndex(entry.article, entry.paragraphIndex)
      }
      return entries
    } catch (error) {
      if ((error as BusinessError).code === FILE_NOT_FOUND) return []
      throw new Error('无法读取本机文章。请重新打开应用后重试。')
    }
  }

  saveLibrary(entries: ReaderLibraryEntry[]): Promise<void> {
    const snapshot = JSON.stringify(entries)
    const write = this.libraryWrites.then(() => this.writeLibrary(snapshot))
    this.libraryWrites = write.catch(() => {})
    return write
  }

  private async writeLibrary(snapshot: string): Promise<void> {
    // Finish and flush the next snapshot before replacing the previous library.
    const temporaryPath = `${this.libraryPath}.tmp`
    try {
      const file = await fileIo.open(temporaryPath, fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC |
        fileIo.OpenMode.WRITE_ONLY)
      try {
        const bytes = this.encoder.encodeInto(snapshot)
        let offset = 0
        while (offset < bytes.byteLength) {
          const buffer = offset === 0 ? bytes.buffer : bytes.slice(offset).buffer
          const written = await fileIo.write(file.fd, buffer)
          if (written <= 0) throw new Error('Incomplete library write')
          offset += written
        }
        await fileIo.fsync(file.fd)
      } finally {
        await fileIo.close(file)
      }
      await fileIo.rename(temporaryPath, this.libraryPath)
    } catch {
      throw new Error('无法保存文章或阅读进度。请重试。')
    }
  }

  async loadModelSettings(): Promise<ReaderModelSettings> {
    await this.settingsWrites
    const query: asset.AssetMap = new Map<asset.Tag, asset.Value>()
    query.set(asset.Tag.ALIAS, this.encoder.encodeInto(SETTINGS_ALIAS))
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL)
    try {
      const rows = await asset.query(query)
      const secret = rows[0]?.get(asset.Tag.SECRET)
      if (!(secret instanceof Uint8Array)) throw new Error('Invalid saved model settings')
      const settings = JSON.parse(util.TextDecoder.create('utf-8').decodeToString(secret)) as ReaderModelSettings
      return validateReaderModelSettings(settings, false)
    } catch (error) {
      const code = (error as BusinessError).code
      if (code === asset.ErrorCode.NOT_FOUND) return defaultReaderModelSettings()
      if (code === asset.ErrorCode.STATUS_MISMATCH) {
        throw new Error('解锁设备后，重新打开应用以读取模型设置。')
      }
      throw new Error('无法从系统安全存储读取模型设置。请重试。')
    }
  }

  async saveModelSettings(settings: ReaderModelSettings): Promise<void> {
    const validated = validateReaderModelSettings(settings, false)
    const secret = this.encoder.encodeInto(JSON.stringify(validated))
    if (secret.byteLength > MAX_SETTINGS_BYTES) throw new Error('模型配置过长。请缩短 API 地址或模型名称。')
    const attributes: asset.AssetMap = new Map<asset.Tag, asset.Value>()
    attributes.set(asset.Tag.ALIAS, this.encoder.encodeInto(SETTINGS_ALIAS))
    attributes.set(asset.Tag.SECRET, secret)
    attributes.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_FIRST_UNLOCKED)
    attributes.set(asset.Tag.SYNC_TYPE, asset.SyncType.NEVER)
    attributes.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE)
    const write = this.settingsWrites.then(() => asset.add(attributes))
    this.settingsWrites = write.catch(() => {})
    try {
      await write
    } catch (error) {
      if ((error as BusinessError).code === asset.ErrorCode.STATUS_MISMATCH) {
        throw new Error('解锁设备后再保存模型设置。')
      }
      throw new Error('无法将模型设置保存到系统安全存储。请重试。')
    }
  }
}
