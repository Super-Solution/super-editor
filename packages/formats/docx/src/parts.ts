// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { escapeXmlAttribute, escapeXmlText, xmlText } from '@supersolutions/super-editor-opc';

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
export const CONTENT_TYPES = {
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
  numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
  settings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
  header: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  footer: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  extended: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
} as const;
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
export const RELATIONSHIPS = { styles: `${REL}styles`, numbering: `${REL}numbering`, settings: `${REL}settings`, header: `${REL}header`, footer: `${REL}footer` } as const;
/** The Word names a document's content is mapped to. Everything the exporter writes with a style uses one of these. */
export const STYLE = { normal: 'Normal', title: 'Title', quote: 'Quote', caption: 'Caption', code: 'CodeBlock', list: 'ListParagraph', tableText: 'TableText', link: 'Hyperlink', header: 'Header', footer: 'Footer', tableGrid: 'TableGrid', sources: 'SourceEntry' } as const;
export const heading = (level: number): string => `Heading${level}`;

export type Fonts = { body: string; mono: string; eastAsia?: string };
export type Metrics = { fontSize: number; lineHeight: number; language: string; eastAsiaLanguage?: string };
const TEXT = '1F2328';

function rFonts(font: string, eastAsia?: string): string {
  const name = escapeXmlAttribute(xmlText(font).text);
  return `<w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:cs="${name}"${eastAsia ? ` w:eastAsia="${escapeXmlAttribute(xmlText(eastAsia).text)}"` : ''}/>`;
}

/** Word style sheet. Sizes follow the document's font size (CSS pixels to half-points); headings scale from it. */
export function stylesXml(fonts: Fonts, metrics: Metrics): string {
  const body = Math.round(metrics.fontSize * 1.5), scaled = (factor: number): number => Math.round(body * factor), line = Math.round(metrics.lineHeight * 240);
  const lang = `<w:lang w:val="${escapeXmlAttribute(metrics.language)}"${metrics.eastAsiaLanguage ? ` w:eastAsia="${escapeXmlAttribute(metrics.eastAsiaLanguage)}"` : ''}/>`;
  const paragraph = (id: string, name: string, extra: { basedOn?: string; next?: string; pPr?: string; rPr?: string; quick?: boolean; priority?: number; link?: string } = {}): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"${id === 'Normal' ? ' w:default="1"' : ''}><w:name w:val="${name}"/>${extra.basedOn ? `<w:basedOn w:val="${extra.basedOn}"/>` : ''}${extra.next ? `<w:next w:val="${extra.next}"/>` : ''}${extra.priority !== undefined ? `<w:uiPriority w:val="${extra.priority}"/>` : ''}${extra.quick === false ? '' : '<w:qFormat/>'}${extra.pPr ? `<w:pPr>${extra.pPr}</w:pPr>` : ''}${extra.rPr ? `<w:rPr>${extra.rPr}</w:rPr>` : ''}</w:style>`;
  const headingStyle = (level: number): string => {
    const factor = [0, 1.7, 1.45, 1.25, 1.1, 1, 1][level]!;
    return paragraph(heading(level), `heading ${level}`, { basedOn: STYLE.normal, next: STYLE.normal, priority: 9, pPr: `<w:keepNext/><w:keepLines/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/>`, rPr: `<w:b/><w:bCs/>${level === 6 ? '<w:i/><w:iCs/>' : ''}<w:sz w:val="${scaled(factor)}"/><w:szCs w:val="${scaled(factor)}"/>` });
  };
  return `${XML_HEADER}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr>${rFonts(fonts.body, fonts.eastAsia)}<w:color w:val="${TEXT}"/><w:sz w:val="${body}"/><w:szCs w:val="${body}"/>${lang}</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="${line}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + paragraph(STYLE.normal, 'Normal')
    + `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>`
    + `<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>`
    + `<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>`
    + paragraph(STYLE.title, 'Title', { basedOn: STYLE.normal, next: STYLE.normal, priority: 10, pPr: '<w:keepNext/><w:spacing w:after="240"/>', rPr: `<w:b/><w:bCs/><w:sz w:val="${scaled(2.1)}"/><w:szCs w:val="${scaled(2.1)}"/>` })
    + [1, 2, 3, 4, 5, 6].map(headingStyle).join('')
    + paragraph(STYLE.quote, 'Quote', { basedOn: STYLE.normal, next: STYLE.normal, priority: 29, pPr: '<w:pBdr><w:left w:val="single" w:sz="24" w:space="10" w:color="D0D7DE"/></w:pBdr><w:ind w:left="360"/>', rPr: '<w:i/><w:iCs/><w:color w:val="57606A"/>' })
    + paragraph(STYLE.caption, 'caption', { basedOn: STYLE.normal, next: STYLE.normal, priority: 35, pPr: '<w:spacing w:before="60" w:after="200"/>', rPr: `<w:i/><w:iCs/><w:color w:val="57606A"/><w:sz w:val="${scaled(0.9)}"/><w:szCs w:val="${scaled(0.9)}"/>` })
    + paragraph(STYLE.code, 'Code Block', { basedOn: STYLE.normal, priority: 40, pPr: '<w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:contextualSpacing/>', rPr: `${rFonts(fonts.mono)}<w:sz w:val="${scaled(0.9)}"/><w:szCs w:val="${scaled(0.9)}"/>` })
    + paragraph(STYLE.list, 'List Paragraph', { basedOn: STYLE.normal, priority: 34, pPr: '<w:spacing w:after="60"/><w:ind w:left="720"/>' })
    + paragraph(STYLE.tableText, 'Table Text', { basedOn: STYLE.normal, priority: 41, pPr: '<w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/>' })
    + paragraph(STYLE.sources, 'Source Entry', { basedOn: STYLE.normal, priority: 42, pPr: '<w:spacing w:after="60"/><w:ind w:left="480" w:hanging="480"/>', rPr: `<w:sz w:val="${scaled(0.9)}"/><w:szCs w:val="${scaled(0.9)}"/>` })
    + paragraph(STYLE.header, 'header', { basedOn: STYLE.normal, priority: 99, quick: false, pPr: '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', rPr: `<w:color w:val="57606A"/><w:sz w:val="${scaled(0.85)}"/><w:szCs w:val="${scaled(0.85)}"/>` })
    + paragraph(STYLE.footer, 'footer', { basedOn: STYLE.normal, priority: 99, quick: false, pPr: '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', rPr: `<w:color w:val="57606A"/><w:sz w:val="${scaled(0.85)}"/><w:szCs w:val="${scaled(0.85)}"/>` })
    + `<w:style w:type="character" w:styleId="${STYLE.link}"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>`
    + `<w:style w:type="table" w:styleId="${STYLE.tableGrid}"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFC5CC"/>`).join('')}</w:tblBorders></w:tblPr></w:style>`
    + '</w:styles>';
}

/** Multilevel bullets (`numId` 1) and one decimal list definition that every numbered list restarts from, with four levels (the editor's maximum indent is 3). */
export function numberingXml(orderedLists: number, bodyFont: string): string {
  const bullets = ['•', '◦', '▪', '•'], decimal = ['decimal', 'lowerLetter', 'lowerRoman', 'decimal'], levels = (kind: 'bullet' | 'number'): string => [0, 1, 2, 3].map(level => {
    const left = 720 + 360 * level;
    return `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${kind === 'bullet' ? 'bullet' : decimal[level]}"/><w:lvlText w:val="${kind === 'bullet' ? bullets[level] : `%${level + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr>${kind === 'bullet' ? `<w:rPr>${rFonts(bodyFont)}</w:rPr>` : ''}</w:lvl>`;
  }).join('');
  const restart = [0, 1, 2, 3].map(level => `<w:lvlOverride w:ilvl="${level}"><w:startOverride w:val="1"/></w:lvlOverride>`).join('');
  return `${XML_HEADER}<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels('number')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`
    + Array.from({ length: orderedLists }, (_, index) => `<w:num w:numId="${index + 2}"><w:abstractNumId w:val="1"/>${restart}</w:num>`).join('') + '</w:numbering>';
}

export const settingsXml = (): string => `${XML_HEADER}<w:settings xmlns:w="${W}"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

export function corePropertiesXml(properties: { title: string; author?: string; created: string; modified: string }): string {
  const text = (value: string): string => escapeXmlText(xmlText(value).text), w3c = (value: string): string => new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${text(properties.title)}</dc:title>${properties.author ? `<dc:creator>${text(properties.author)}</dc:creator>` : ''}<dcterms:created xsi:type="dcterms:W3CDTF">${w3c(properties.created)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${w3c(properties.modified)}</dcterms:modified></cp:coreProperties>`;
}
export const extendedPropertiesXml = (): string => `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Super Editor</Application></Properties>`;
