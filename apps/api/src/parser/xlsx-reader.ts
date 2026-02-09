import ExcelJS from "exceljs";

export interface XlsxSheet {
  grid: string[][];
  boldCells: [number, number][];
  sheetName: string;
  sheetIndex: number;
}

export interface XlsxWorkbook {
  sheets: XlsxSheet[];
  fileName?: string;
}

// Keep the old type as an alias so downstream code that references XlsxGrid still works
export type XlsxGrid = XlsxSheet;

function cellToString(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";

  // Handle formula results
  if (typeof value === "object" && "result" in value) {
    const result = (value as ExcelJS.CellFormulaValue).result;
    if (result === null || result === undefined) return "";
    if (result instanceof Date) return result.toISOString();
    return String(result);
  }

  // Handle rich text
  if (typeof value === "object" && "richText" in value) {
    return (value as ExcelJS.CellRichTextValue).richText
      .map((rt) => rt.text)
      .join("");
  }

  // Handle dates
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Handle hyperlinks
  if (typeof value === "object" && "hyperlink" in value) {
    return (value as ExcelJS.CellHyperlinkValue).text || String(value);
  }

  // Handle shared formula
  if (typeof value === "object" && "sharedFormula" in value) {
    const result = (value as ExcelJS.CellSharedFormulaValue).result;
    if (result === null || result === undefined) return "";
    return String(result);
  }

  // Handle error values
  if (typeof value === "object" && "error" in value) {
    return String((value as ExcelJS.CellErrorValue).error);
  }

  return String(value);
}

function extractSheet(worksheet: ExcelJS.Worksheet, sheetIndex: number): XlsxSheet | null {
  if (worksheet.rowCount === 0 || worksheet.columnCount === 0) return null;

  // Build a map of merged cell values
  const mergedValues = new Map<string, ExcelJS.CellValue>();
  const mergedFonts = new Map<string, Partial<ExcelJS.Font> | undefined>();

  for (const mergeRange of worksheet.model.merges ?? []) {
    const [startRef, endRef] = mergeRange.split(":");
    const startCell = worksheet.getCell(startRef);
    const masterValue = startCell.value;
    const masterFont = startCell.font;

    const startRow = Number(startCell.row);
    const startCol = Number(startCell.col);
    const endCell = worksheet.getCell(endRef);
    const endRow = Number(endCell.row);
    const endCol = Number(endCell.col);

    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const key = `${row}:${col}`;
        mergedValues.set(key, masterValue);
        mergedFonts.set(key, masterFont);
      }
    }
  }

  const grid: string[][] = [];
  const boldCells: [number, number][] = [];
  const totalRows = worksheet.rowCount;
  const totalCols = worksheet.columnCount;

  for (let rowIdx = 1; rowIdx <= totalRows; rowIdx++) {
    const row = worksheet.getRow(rowIdx);
    const rowData: string[] = [];

    for (let colIdx = 1; colIdx <= totalCols; colIdx++) {
      const mergeKey = `${rowIdx}:${colIdx}`;
      const cell = row.getCell(colIdx);

      let cellValue: string;
      if (mergedValues.has(mergeKey)) {
        const masterVal = mergedValues.get(mergeKey);
        if (masterVal === null || masterVal === undefined) {
          cellValue = "";
        } else if (masterVal instanceof Date) {
          cellValue = masterVal.toISOString();
        } else if (typeof masterVal === "object" && "result" in masterVal) {
          cellValue = String(masterVal.result ?? "");
        } else if (typeof masterVal === "object" && "richText" in masterVal) {
          cellValue = (masterVal as ExcelJS.CellRichTextValue).richText
            .map((rt) => rt.text)
            .join("");
        } else {
          cellValue = String(masterVal);
        }
      } else {
        cellValue = cellToString(cell);
      }

      rowData.push(cellValue.trim());

      const font = mergedFonts.has(mergeKey)
        ? mergedFonts.get(mergeKey)
        : cell.font;
      if (font?.bold === true) {
        boldCells.push([rowIdx - 1, colIdx - 1]);
      }
    }

    grid.push(rowData);
  }

  // Remove trailing empty rows
  while (grid.length > 0 && grid[grid.length - 1].every((c) => c === "")) {
    grid.pop();
  }

  if (grid.length === 0) return null;

  return {
    grid,
    boldCells,
    sheetName: worksheet.name,
    sheetIndex,
  };
}

export async function readXlsx(buffer: Buffer): Promise<XlsxWorkbook> {
  const startTime = Date.now();
  console.log("xlsx-reader: Starting workbook load...");

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);

  const sheets: XlsxSheet[] = [];

  for (let i = 0; i < workbook.worksheets.length; i++) {
    const worksheet = workbook.worksheets[i];
    const sheet = extractSheet(worksheet, i);
    if (sheet) {
      sheets.push(sheet);
      console.log(
        `xlsx-reader: Sheet "${sheet.sheetName}" — ${sheet.grid.length} rows, ${sheet.grid[0]?.length ?? 0} cols, ${sheet.boldCells.length} bold cells`,
      );
    }
  }

  if (sheets.length === 0) {
    throw new Error("No worksheets with data found in the uploaded file");
  }

  const elapsed = Date.now() - startTime;
  const totalRows = sheets.reduce((sum, s) => sum + s.grid.length, 0);
  console.log(
    `xlsx-reader: Done in ${elapsed}ms — ${sheets.length} sheet(s), ${totalRows} total rows`,
  );

  return { sheets };
}
