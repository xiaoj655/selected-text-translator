// Contextual IPA selects a vetted pronunciation from the CMU Pronouncing Dictionary.
const PRONUNCIATIONS = {
  bass: [
    ['bæs', 'B AE1 S'],
    ['beɪs', 'B EY1 S'],
  ],
  bow: [
    ['baʊ', 'B AW1'],
    ['boʊ', 'B OW1'],
  ],
  close: [
    ['kloʊs', 'K L OW1 S'],
    ['kloʊz', 'K L OW1 Z'],
  ],
  dove: [
    ['dʌv', 'D AH1 V'],
    ['doʊv', 'D OW1 V'],
  ],
  lead: [
    ['lɛd', 'L EH1 D', 'led'],
    ['lid', 'L IY1 D'],
  ],
  live: [
    ['laɪv', 'L AY1 V'],
    ['lɪv', 'L IH1 V'],
  ],
  read: [
    ['rɛd', 'R EH1 D', 'red'],
    ['rid', 'R IY1 D'],
  ],
  record: [
    ['ˈrɛkərd', 'R EH1 K ER0 D', 'ˈrɛkɔrd', 'ˈrekərd', 'ˈrekɔrd'],
    ['rəˈkɔrd', 'R AH0 K AO1 R D'],
    ['rɪˈkɔrd', 'R IH0 K AO1 R D'],
  ],
  tear: [
    ['tɛr', 'T EH1 R', 'tɛər', 'teər', 'ter'],
    ['tɪr', 'T IH1 R', 'tɪər'],
  ],
  use: [
    ['jus', 'Y UW1 S'],
    ['juz', 'Y UW1 Z'],
  ],
  wind: [
    ['waɪnd', 'W AY1 N D'],
    ['wɪnd', 'W IH1 N D'],
  ],
  wound: [
    ['waʊnd', 'W AW1 N D'],
    ['wund', 'W UW1 N D'],
  ],
}

export function hasContextualPronunciations(word) {
  return Object.hasOwn(PRONUNCIATIONS, String(word ?? '').trim().toLowerCase())
}

export function resolveContextualPronunciation(word, ipa) {
  const key = String(word ?? '').trim().toLowerCase()
  if (!Object.hasOwn(PRONUNCIATIONS, key) || typeof ipa !== 'string') return null

  let normalized = ipa.trim().normalize('NFC')
    .replace(/^\/(.+)\/$|^\[(.+)\]$/u, '$1$2')
    .replace(/[\s.ːˑˌ]/gu, '')
    .replace(/ɹ/gu, 'r')
    .replace(/ɚ|ə˞/gu, 'ər')
  if (key !== 'record') normalized = normalized.replace(/^ˈ/u, '')

  const variant = PRONUNCIATIONS[key].find(([standard, , ...aliases]) =>
    normalized === standard || aliases.includes(normalized))
  if (!variant) return null

  const [standard, phonemes] = variant
  return { phonemes, ipa: `/${standard}/` }
}
