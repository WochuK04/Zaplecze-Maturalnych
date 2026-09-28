// Generowanie dokumentu PDF operacji magazynowej (przyjęcie/dostawa/konwersja/…).
//
// Osobny moduł, by logika układu była testowalna wprost (buduje strumień PDF z
// obiektu szczegółu operacji — tego samego, który zwraca GET /warehouse/operations/:id).
// Polskie znaki wymagają osadzonego fontu Unicode — używamy DejaVu Sans (assets/fonts).

import path from 'path';
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/fonts');
const FONT_REGULAR = path.join(FONT_DIR, 'DejaVuSans.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

const STATE_LABELS = {
  draft: 'Wersja robocza', ready: 'Gotowe', done: 'Wykonano', cancelled: 'Anulowano'
};

function fmtDate(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtZl(n) {
  return `${(Number(n) || 0).toFixed(2).replace('.', ',')} zł`;
}

// Ilość na wydruku. Produkty na kilogramy mają stany ułamkowe, a `String(9.5)` daje
// „9.5" — kropkę dziesiętną na polskim dokumencie idącym do księgowości.
function fmtIlosc(n) {
  return (Number(n) || 0).toLocaleString('pl-PL', { maximumFractionDigits: 3 });
}

// Konfiguracja kolumn tabeli pozycji zależnie od typu operacji. Szerokości sumują się
// do ~495 pkt (A4, margines 50). Zwraca { columns:[{label,width,align}], rows:[[...]], totalValue }.
export function buildLinesTable(op) {
  const lines = Array.isArray(op.lines) ? op.lines : [];

  if (op.type === 'receipt') {
    let totalValue = 0;
    let priced = 0;      // cena wprost z dokumentu
    let estimated = 0;   // wycena wtórna kosztem kartoteki (dokument z importu Odoo)
    const rows = lines.map(l => {
      const qty = Number(l.quantity) || 0;
      // Cena z dokumentu ma pierwszeństwo. Gdy jej nie ma — bo dokument odtworzyliśmy
      // z historii Odoo, a ta nie niesie kosztu w pozycjach — wchodzi wycena FIFO
      // z partii kartoteki (liczy ją wołający). Kolumna jest jedna, więc pozycja
      // rozłożona na dwie warstwy pokazuje cenę wypadkową dokładnie tych warstw.
      // Gwiazdka i nota pod tabelą mówią, że to wycena, nie kwota z faktury. Zera nie
      // drukujemy nigdy: „0,00 zł" znaczyłoby, że towar przyszedł za darmo.
      const zDokumentu = l.unitPrice != null && Number.isFinite(Number(l.unitPrice));
      const zKartoteki = !zDokumentu && l.fallbackUnitPrice != null && Number.isFinite(Number(l.fallbackUnitPrice));
      if (!zDokumentu && !zKartoteki) return [l.itemCode || '', l.itemName || '', fmtIlosc(qty), '—', '—'];

      const price = Number(zDokumentu ? l.unitPrice : l.fallbackUnitPrice);
      const value = qty * price;
      totalValue += value;
      if (zDokumentu) priced += 1; else estimated += 1;
      const gwiazdka = zDokumentu ? '' : ' *';
      return [l.itemCode || '', l.itemName || '', fmtIlosc(qty), fmtZl(price) + gwiazdka, fmtZl(value) + gwiazdka];
    });
    return {
      columns: [
        { label: 'Kod', width: 90 }, { label: 'Nazwa', width: 195 },
        { label: 'Ilość', width: 50, align: 'right' },
        { label: 'Cena', width: 75, align: 'right' },
        { label: 'Wartość', width: 85, align: 'right' }
      ],
      rows,
      totalValue,
      pricedLines: priced,
      estimatedLines: estimated,
      unpricedLines: lines.length - priced - estimated
    };
  }

  if (op.type === 'conversion') {
    return {
      columns: [
        { label: 'Towar (kod)', width: 90 }, { label: 'Nazwa', width: 150 },
        { label: 'Ilość', width: 45, align: 'right' },
        { label: 'Cel — gadżet', width: 90 }, { label: 'Nazwa celu', width: 120 }
      ],
      rows: lines.map(l => [
        l.itemCode || '', l.itemName || '', fmtIlosc(l.quantity),
        l.targetItemCode || '', l.targetName || ''
      ])
    };
  }

  if (op.type === 'adjustment') {
    return {
      columns: [
        { label: 'Kod', width: 90 }, { label: 'Nazwa', width: 195 },
        { label: 'Lokalizacja', width: 120 },
        { label: 'Policzono', width: 90, align: 'right' }
      ],
      rows: lines.map(l => [
        l.itemCode || '', l.itemName || '', l.locationName || op.toName || '—',
        l.countedQty != null ? fmtIlosc(l.countedQty) : '—'
      ])
    };
  }

  // delivery / internal / scrap — kod, nazwa, ilość, partia.
  return {
    columns: [
      { label: 'Kod', width: 110 }, { label: 'Nazwa', width: 245 },
      { label: 'Ilość', width: 60, align: 'right' },
      { label: 'Partia', width: 80 }
    ],
    rows: lines.map(l => [
      l.itemCode || '', l.itemName || '', fmtIlosc(l.quantity), l.lot || '—'
    ])
  };
}

function drawTable(doc, columns, rows, startY) {
  const left = doc.page.margins.left;
  const totalWidth = columns.reduce((s, c) => s + c.width, 0);
  let y = startY;

  doc.font('Bold').fontSize(9).fillColor('#000');
  let x = left;
  columns.forEach(c => { doc.text(c.label, x, y, { width: c.width, align: c.align || 'left' }); x += c.width; });
  y += 15;
  doc.moveTo(left, y).lineTo(left + totalWidth, y).strokeColor('#999999').lineWidth(0.5).stroke();
  y += 5;

  doc.font('Sans').fontSize(9).fillColor('#111111');
  rows.forEach(cells => {
    // Łamanie strony, gdy zabraknie miejsca (zostawiamy zapas na stopkę/podpisy).
    if (y > doc.page.height - doc.page.margins.bottom - 90) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    let cx = left;
    let maxH = 0;
    columns.forEach(c => {
      const text = String(cells[columns.indexOf(c)] ?? '');
      const h = doc.heightOfString(text, { width: c.width });
      if (h > maxH) maxH = h;
      doc.text(text, cx, y, { width: c.width, align: c.align || 'left' });
      cx += c.width;
    });
    y += Math.max(16, maxH + 4);
  });

  return { endY: y, totalWidth, left };
}

// Rysuje cały dokument do podanego PDFDocument.
export function renderOperationPdf(doc, op) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  // Nagłówek firmowy + tytuł dokumentu.
  doc.font('Sans').fontSize(10).fillColor('#666666')
    .text('Maturalni — Obieg sprzętu · Magazyn', left, doc.page.margins.top);
  doc.font('Bold').fontSize(20).fillColor('#000000')
    .text(op.typeLabel || op.type || 'Operacja', { continued: false });
  doc.font('Sans').fontSize(12).fillColor('#333333')
    .text(`Dokument: ${op.reference || '—'}`);
  doc.moveDown(0.5);

  // Meta — para etykieta/wartość.
  const meta = [
    ['Status', STATE_LABELS[op.state] || op.state || '—'],
    ['Z lokalizacji', op.fromName || '—'],
    ['Do lokalizacji', op.toName || '—']
  ];
  if (op.supplierName) meta.push(['Dostawca', op.supplierName]);
  if (op.destinationName) meta.push(['Miejsce dostawy', op.destinationName]);
  if (op.contact) meta.push(['Kontakt', op.contact]);
  if (op.sourceDocument) meta.push(['Dokument źródłowy', op.sourceDocument]);
  meta.push(['Zaplanowano', fmtDate(op.scheduledAt)]);
  meta.push(['Wykonano', fmtDate(op.doneAt)]);
  meta.push(['Utworzono', fmtDate(op.createdAt)]);

  doc.fontSize(10);
  meta.forEach(([k, v]) => {
    doc.font('Bold').fillColor('#000000').text(`${k}: `, { continued: true });
    doc.font('Sans').fillColor('#333333').text(String(v));
  });

  if (op.note) {
    doc.moveDown(0.4);
    doc.font('Bold').fillColor('#000000').text('Uwagi: ', { continued: true });
    doc.font('Sans').fillColor('#333333').text(String(op.note));
  }

  doc.moveDown(1);
  doc.font('Bold').fontSize(12).fillColor('#000000').text('Pozycje');
  doc.moveDown(0.3);

  const { columns, rows, totalValue, pricedLines, estimatedLines, unpricedLines } = buildLinesTable(op);
  const startY = doc.y;
  let endY = startY;
  if (rows.length) {
    const res = drawTable(doc, columns, rows, startY);
    endY = res.endY;
  } else {
    doc.font('Sans').fontSize(10).fillColor('#666666').text('Brak pozycji.', left, startY);
    endY = doc.y;
  }

  // Podsumowanie przyjęcia. Nazwa sumy musi odpowiadać temu, co w niej siedzi:
  // „wartość zakupu" ma znaczyć kwotę z dokumentu. Gdy wszystko policzono z partii,
  // to jest wycena, nie zakup — i etykieta ma to mówić, bo ten papier czyta
  // księgowość. Zera nie drukujemy nigdy: znaczyłoby „za darmo".
  if (op.type === 'receipt') {
    let y = endY + 6;
    const maCokolwiek = pricedLines > 0 || estimatedLines > 0;
    const etykieta = !maCokolwiek ? 'Razem: brak danych'
      : pricedLines === 0 ? `Razem (wycena FIFO z partii): ${fmtZl(totalValue)}`
      : `Razem (wartość zakupu): ${fmtZl(totalValue)}`;
    doc.font('Bold').fontSize(11).fillColor('#000000')
      .text(etykieta, left, y, { width: right - left, align: 'right' });

    const noty = [];
    if (estimatedLines > 0) {
      const ile = pricedLines === 0
        ? 'Dokument nie niósł własnych cen'
        : `${estimatedLines} z ${rows.length} pozycji`;
      noty.push(`* ${ile} — wyceniono FIFO z partii cenowych kartoteki. Partie opisują stan bieżący, nie ten z dnia przyjęcia.`);
    }
    if (unpricedLines > 0) {
      noty.push(`${unpricedLines} z ${rows.length} pozycji bez ceny — kartoteka nie ma żadnej partii cenowej.`);
    }
    for (const nota of noty) {
      y = doc.y + 2;
      doc.font('Sans').fontSize(9).fillColor('#666666')
        .text(nota, left, y, { width: right - left, align: 'right' });
    }
  }

  // Podpisy na dole strony.
  const sigY = doc.page.height - doc.page.margins.bottom - 50;
  const colW = (right - left - 40) / 2;
  doc.font('Sans').fontSize(9).fillColor('#000000');
  doc.moveTo(left, sigY).lineTo(left + colW, sigY).strokeColor('#999999').lineWidth(0.5).stroke();
  doc.moveTo(left + colW + 40, sigY).lineTo(right, sigY).stroke();
  doc.text('Wystawił', left, sigY + 4, { width: colW, align: 'center' });
  doc.text('Odebrał / Zatwierdził', left + colW + 40, sigY + 4, { width: colW, align: 'center' });
}

// Tworzy PDFDocument z osadzonym fontem i narysowanym dokumentem. Wołający pipe'uje.
export function createOperationPdfDoc(op) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Operacja ${op.reference || ''}` } });
  doc.registerFont('Sans', FONT_REGULAR);
  doc.registerFont('Bold', FONT_BOLD);
  doc.font('Sans');
  renderOperationPdf(doc, op);
  return doc;
}
