// M3c-3 知识库 T19 上传解析（纯函数，无 DB）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.5、§5.3；F3 T19 完成标准
// 覆盖：五格式（.txt/.md/.docx/.pdf/.html）正例；20MB 上限 413；非法类型 415；
//       解析失败 422 带文件名；编码探测（GBK/UTF-8）；文件名清洗防路径穿越。
import { knowledgeErrorCode } from '@storyforge/contracts';
import {
  UPLOAD_MAX_BYTES,
  UPLOAD_SUPPORTED_EXTENSIONS,
  cleanUploadFileName,
  extractUploadText
} from './upload.parser';

const { KNOWLEDGE_FILE_TOO_LARGE, KNOWLEDGE_FILE_TYPE_UNSUPPORTED, KNOWLEDGE_PARSE_FAILED } =
  knowledgeErrorCode;

describe('KnowledgeUploadParser · 文件名清洗', () => {
  it('清洗路径穿越与非法字符', () => {
    expect(cleanUploadFileName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(cleanUploadFileName('a\\b\\c.md')).toBe('c.md');
    expect(cleanUploadFileName('..\\..\\x.pdf')).toBe('x.pdf');
    expect(cleanUploadFileName('正常文件名.docx')).toBe('正常文件名.docx');
  });

  it('空文件名抛 422', () => {
    expect(() => cleanUploadFileName('')).toThrow();
  });
});

describe('KnowledgeUploadParser · 格式白名单', () => {
  it('支持扩展名集合正确', () => {
    expect(UPLOAD_SUPPORTED_EXTENSIONS).toEqual(['.txt', '.md', '.docx', '.pdf', '.html']);
  });
});

describe('KnowledgeUploadParser · 文本提取', () => {
  it('txt 提取 UTF-8 文本', async () => {
    const buf = Buffer.from('你好，世界\n第二行', 'utf8');
    const res = await extractUploadText('.txt', buf, 'a.txt', 'text/plain');
    expect(res.text).toContain('你好，世界');
  });

  it('txt 回退 GB18030 编码（UTF-8 无效时）', async () => {
    // GBK 编码的「你好」字节序列
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    const res = await extractUploadText('.txt', gbk, 'gbk.txt', 'text/plain');
    expect(res.text).toContain('你好');
  });

  it('md 提取 Markdown 正文', async () => {
    const buf = Buffer.from('# 标题\n\n正文段落', 'utf8');
    const res = await extractUploadText('.md', buf, 'a.md', 'text/markdown');
    expect(res.text).toContain('标题');
    expect(res.text).toContain('正文段落');
  });

  it('html 提取文本（去标签）', async () => {
    const buf = Buffer.from('<html><body><p>正文内容</p><p>第二段</p></body></html>', 'utf8');
    const res = await extractUploadText('.html', buf, 'a.html', 'text/html');
    expect(res.text).toContain('正文内容');
    expect(res.text).toContain('第二段');
  });

  it('docx 用 mammoth 提取正文', async () => {
    // 构造最小 docx（zip 内含 document.xml）
    const docx = await makeMinimalDocx('docx 测试正文');
    const res = await extractUploadText('.docx', docx, 'a.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(res.text).toContain('docx 测试正文');
  });

  it('pdf 用 unpdf 提取文本', async () => {
    // unpdf 对 Helvetica 基础字体只映射 WinAnsi，中文会提取为空；用 ASCII 文本验证
    const pdf = await makeSimplePdfWithText('PDF Test Content');
    const res = await extractUploadText('.pdf', pdf, 'a.pdf', 'application/pdf');
    expect(res.text).toContain('PDF Test Content');
  });

  it('超过 20MB 抛 413', async () => {
    const big = Buffer.alloc(UPLOAD_MAX_BYTES + 1, 0x61);
    await expect(extractUploadText('.txt', big, 'big.txt', 'text/plain')).rejects.toMatchObject({
      response: { code: KNOWLEDGE_FILE_TOO_LARGE }
    });
  });

  it('非法扩展名抛 415', async () => {
    await expect(extractUploadText('.exe', Buffer.from('x'), 'a.exe', 'application/octet-stream')).rejects.toMatchObject({
      response: { code: KNOWLEDGE_FILE_TYPE_UNSUPPORTED }
    });
  });

  it('解析失败抛 422 并带文件名', async () => {
    // 损坏的 PDF：mammoth/unpdf 无法解析
    const broken = Buffer.from('not a real pdf content');
    await expect(extractUploadText('.pdf', broken, 'broken.pdf', 'application/pdf')).rejects.toMatchObject({
      response: { code: KNOWLEDGE_PARSE_FAILED, fileName: 'broken.pdf' }
    });
  });

  it('docx 损坏抛 422', async () => {
    const broken = Buffer.from('not a zip');
    await expect(extractUploadText('.docx', broken, 'broken.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).rejects.toMatchObject({
      response: { code: KNOWLEDGE_PARSE_FAILED }
    });
  });
});

// ───────────────────────── 测试辅助：构造 docx/pdf ─────────────────────────
async function makeMinimalDocx(text: string): Promise<Buffer> {
  // 用 zip 最小结构：mimetype + document.xml
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeSimplePdfWithText(text: string): Promise<Buffer> {
  // 构造含文本流的最小 PDF（Helvetica 单行文本）
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects: string[] = [];
  objects.push('<</Type/Catalog/Pages 2 0 R>>');
  objects.push('<</Type/Pages/Kids[3 0 R]/Count 1>>');
  objects.push(
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>`
  );
  objects.push(`<</Length ${content.length}>>stream\n${content}\nendstream`);
  objects.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'binary');
}
