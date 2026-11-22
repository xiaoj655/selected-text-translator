import sanitizeHtml from 'sanitize-html'
import { DOMParser } from 'linkedom'

const TAGS = ['svg', 'g', 'defs', 'symbol', 'use', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'textPath', 'title', 'desc', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern',
  'marker', 'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feFuncR',
  'feFuncG', 'feFuncB', 'feFuncA', 'feMerge', 'feMergeNode', 'feComposite', 'feFlood', 'feDropShadow']
const ATTRIBUTES = ['id', 'xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color', 'font-family',
  'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'dx', 'dy', 'rotate', 'textLength',
  'lengthAdjust', 'href', 'xlink:href', 'xmlns:xlink', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform',
  'spreadMethod', 'fx', 'fy', 'fr', 'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'maskContentUnits',
  'patternUnits', 'patternContentUnits', 'patternTransform', 'marker-start', 'marker-mid', 'marker-end', 'markerWidth',
  'markerHeight', 'refX', 'refY', 'orient', 'preserveAspectRatio', 'filter', 'filterUnits', 'in', 'in2', 'result', 'stdDeviation',
  'mode', 'type', 'values', 'operator', 'k1', 'k2', 'k3', 'k4', 'flood-color', 'flood-opacity', 'slope', 'intercept',
  'amplitude', 'exponent', 'tableValues']

export function sanitizeReadingSvg(value) {
  const clean = sanitizeHtml(value, {
    allowedTags: TAGS,
    allowedAttributes: { '*': ATTRIBUTES },
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    allowedSchemes: [],
    allowProtocolRelative: false,
    nonTextTags: ['script', 'style', 'foreignObject', 'iframe', 'object', 'embed', 'image', 'animate', 'animateTransform', 'set'],
    nestingLimit: 80,
    transformTags: {
      '*': (tagName, attributes) => {
        const attribs = {}
        for (const [name, original] of Object.entries(attributes)) {
          const value = original.trim()
          if (name === 'href' || name === 'xlink:href') {
            if (/^#[A-Za-z_][\w:.-]*$/u.test(value)) attribs[name] = value
          } else if (name === 'xmlns') {
            if (value === 'http://www.w3.org/2000/svg') attribs[name] = value
          } else if (name === 'xmlns:xlink') {
            if (value === 'http://www.w3.org/1999/xlink') attribs[name] = value
          } else if (!/url\s*\(/iu.test(value) || /^url\(\s*#[A-Za-z_][\w:.-]*\s*\)$/u.test(value)) {
            attribs[name] = value
          }
        }
        return { tagName, attribs }
      },
    },
  })
  const document = new DOMParser().parseFromString(clean, 'image/svg+xml')
  const svg = document.documentElement
  if (svg?.localName !== 'svg') throw new Error('Invalid SVG image')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return svg.outerHTML
}
