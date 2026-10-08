/**
 * 原生 Word (`.docx`) 医学标准三线表自动生成器 (Native OpenXML Table 1 Exporter)
 * 
 * 专为符合 ICMJE / NEJM / Lancet / JAMA 医学期刊排版规范打造：
 * - 纯净三线表外观：顶线 1.5 磅粗线、表头底线 0.75 磅细线、表格底线 1.5 磅粗线，绝无垂直竖线；
 * - 变量层级排版：主变量行加粗，分类子级别缩进，缺失值行斜体；
 * - 字体自适应：中文字体默认宋体，西文字体与数字默认 Times New Roman；
 * - 统计注解：底部自动生成统计检验方法注解段落（t 检验、Mann-Whitney U、卡方检验、SMD 均衡标准）。
 */

import { strToU8, zipSync } from 'fflate'
import type { Table1Result, Table1Row } from './table1.ts'

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 将 Table1Result 导出为原生态 Word (.docx) 二进制文件流
 */
export function exportTable1ToDocx(result: Table1Result): Uint8Array {
  const { title, headers, rows, footnotes = [] } = result

  // Generate Table XML
  let tblXml = `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="0" w:type="auto"/>
      <w:jc w:val="center"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="12" w:space="0" w:color="000000"/>
        <w:left w:val="none"/>
        <w:bottom w:val="single" w:sz="12" w:space="0" w:color="000000"/>
        <w:right w:val="none"/>
        <w:insideH w:val="none"/>
        <w:insideV w:val="none"/>
      </w:tblBorders>
      <w:tblCellMar>
        <w:top w:w="120" w:type="dxa"/>
        <w:left w:w="160" w:type="dxa"/>
        <w:bottom w:w="120" w:type="dxa"/>
        <w:right w:w="160" w:type="dxa"/>
      </w:tblCellMar>
    </w:tblPr>`

  // Header Row
  tblXml += `<w:tr>
    <w:trPr>
      <w:tblHeader/>
      <w:cantSplit/>
    </w:trPr>`

  headers.forEach((h, colIdx) => {
    const jc = colIdx === 0 ? 'left' : 'center'
    tblXml += `<w:tc>
      <w:tcPr>
        <w:tcBorders>
          <w:bottom w:val="single" w:sz="6" w:space="0" w:color="000000"/>
        </w:tcBorders>
        <w:vAlign w:val="center"/>
      </w:tcPr>
      <w:p>
        <w:pPr>
          <w:jc w:val="${jc}"/>
          <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
        </w:pPr>
        <w:r>
          <w:rPr>
            <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>
            <w:b/>
            <w:sz w:val="21"/>
          </w:rPr>
          <w:t xml:space="preserve">${esc(h)}</w:t>
        </w:r>
      </w:p>
    </w:tc>`
  })
  tblXml += `</w:tr>`

  // Data Rows
  rows.forEach(r => {
    tblXml += renderRow(r, headers)
  })

  tblXml += `</w:tbl>`

  // Footnote Paragraphs below Table
  let footnotesXml = ''
  if (footnotes.length > 0) {
    footnotesXml += `<w:p><w:pPr><w:spacing w:before="120" w:after="40"/></w:pPr></w:p>`
    footnotes.forEach(fn => {
      footnotesXml += `<w:p>
        <w:pPr>
          <w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/>
          <w:ind w:left="0"/>
        </w:pPr>
        <w:r>
          <w:rPr>
            <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>
            <w:sz w:val="18"/>
            <w:color w:val="475569"/>
          </w:rPr>
          <w:t xml:space="preserve">${esc(fn)}</w:t>
        </w:r>
      </w:p>`
    })
  }

  // Document Body
  const titleXml = `<w:p>
    <w:pPr>
      <w:spacing w:before="240" w:after="160"/>
    </w:pPr>
    <w:r>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>
        <w:b/>
        <w:sz w:val="26"/>
        <w:color w:val="0f172a"/>
      </w:rPr>
      <w:t xml:space="preserve">${esc(title || 'Table 1. Baseline Characteristics')}</w:t>
    </w:r>
  </w:p>`

  const bodyXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}>
  <w:body>
    ${titleXml}
    ${tblXml}
    ${footnotesXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838" w:orient="portrait"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${NS}>
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>
        <w:sz w:val="21"/>
        <w:lang w:val="en-US" w:eastAsia="zh-CN"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="60" w:line="240" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
</w:styles>`

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>
</Relationships>`

  const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>
</Relationships>`

  const pkgFiles: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels': strToU8(relsXml),
    'word/document.xml': strToU8(bodyXml),
    'word/styles.xml': strToU8(stylesXml),
    'word/_rels/document.xml.rels': strToU8(docRelsXml),
  }

  return zipSync(pkgFiles)
}

function renderRow(r: Table1Row, headers: string[]): string {
  let rowXml = `<w:tr><w:trPr><w:cantSplit/></w:trPr>`

  // 1. Variable label column
  const isBold = r.indent === 0
  const indentDxa = r.indent === 1 ? 240 : r.indent === 2 ? 400 : 0
  const isItalic = r.indent === 2 // missing values

  rowXml += `<w:tc>
    <w:tcPr><w:vAlign w:val="center"/></w:tcPr>
    <w:p>
      <w:pPr>
        <w:jc w:val="left"/>
        ${indentDxa > 0 ? `<w:ind w:left="${indentDxa}"/>` : ''}
        <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>
          ${isBold ? '<w:b/>' : ''}
          ${isItalic ? '<w:i/>' : ''}
          <w:sz w:val="20"/>
        </w:rPr>
        <w:t xml:space="preserve">${esc(r.label)}</w:t>
      </w:r>
    </w:p>
  </w:tc>`

  // Remaining data columns
  // Map values according to headers
  const vals: string[] = []
  if (headers.some(h => h.startsWith('Overall'))) {
    vals.push(r.overall ?? '')
  }
  Object.keys(r.groups).forEach(gKey => {
    vals.push(r.groups[gKey] ?? '')
  })
  if (headers.some(h => h.includes('P Value') || h.includes('P值'))) {
    vals.push(r.p_value_formatted ?? '')
  }
  if (headers.some(h => h.includes('SMD'))) {
    vals.push(r.smd_formatted ?? '')
  }

  vals.forEach(val => {
    rowXml += `<w:tc>
      <w:tcPr><w:vAlign w:val="center"/></w:tcPr>
      <w:p>
        <w:pPr>
          <w:jc w:val="center"/>
          <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
        </w:pPr>
        <w:r>
          <w:rPr>
            <w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>
            ${isItalic ? '<w:i/>' : ''}
            <w:sz w:val="20"/>
          </w:rPr>
          <w:t xml:space="preserve">${esc(val)}</w:t>
        </w:r>
      </w:p>
    </w:tc>`
  })

  rowXml += `</w:tr>`
  return rowXml
}
