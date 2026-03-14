import fs from "node:fs";
import readline from "node:readline";
import zlib from "node:zlib";

export type SqlValue = string | number | null;

export interface SqlTableSchema {
  tableName: string;
  columns: string[];
  columnIndex: Map<string, number>;
}

async function* iterateGzipLines(filePath: string): AsyncGenerator<string> {
  const stream = fs.createReadStream(filePath).pipe(zlib.createGunzip());
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity
  });

  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export async function readTableSchema(filePath: string, tableName: string): Promise<SqlTableSchema> {
  const columns: string[] = [];
  let insideTable = false;
  const createStart = `CREATE TABLE \`${tableName}\` (`;

  for await (const line of iterateGzipLines(filePath)) {
    if (!insideTable && line.startsWith(createStart)) {
      insideTable = true;
      continue;
    }

    if (!insideTable) {
      continue;
    }

    if (line.startsWith(") ENGINE=")) {
      break;
    }

    const match = line.match(/^\s*`([^`]+)`/);
    if (match) {
      columns.push(match[1]!);
    }
  }

  if (columns.length === 0) {
    throw new Error(`Unable to read schema for table ${tableName} from ${filePath}`);
  }

  return {
    tableName,
    columns,
    columnIndex: new Map(columns.map((column, index) => [column, index]))
  };
}

function decodeSqlString(raw: string): string {
  let output = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char !== "\\") {
      output += char;
      continue;
    }

    index += 1;
    const escaped = raw[index];
    if (escaped === undefined) {
      break;
    }

    switch (escaped) {
      case "0":
        output += "\0";
        break;
      case "n":
        output += "\n";
        break;
      case "r":
        output += "\r";
        break;
      case "t":
        output += "\t";
        break;
      case "Z":
        output += "\u001a";
        break;
      default:
        output += escaped;
        break;
    }
  }

  return output;
}

export function* parseInsertRows(line: string): Generator<SqlValue[]> {
  const valuesIndex = line.indexOf(" VALUES ");
  if (valuesIndex === -1) {
    return;
  }

  let index = valuesIndex + " VALUES ".length;

  while (index < line.length) {
    while (index < line.length && (line[index] === "," || line[index] === " " || line[index] === ";")) {
      index += 1;
    }

    if (index >= line.length || line[index] !== "(") {
      break;
    }

    index += 1;
    const row: SqlValue[] = [];

    while (index < line.length) {
      const char = line[index];
      if (char === "'") {
        index += 1;
        let raw = "";
        while (index < line.length) {
          const inner = line[index];
          if (inner === "\\") {
            raw += inner;
            index += 1;
            if (index < line.length) {
              raw += line[index];
              index += 1;
            }
            continue;
          }

          if (inner === "'") {
            index += 1;
            break;
          }

          raw += inner;
          index += 1;
        }

        row.push(decodeSqlString(raw));
      } else {
        const start = index;
        while (index < line.length && line[index] !== "," && line[index] !== ")") {
          index += 1;
        }

        const token = line.slice(start, index).trim();
        if (token === "NULL") {
          row.push(null);
        } else if (token.length === 0) {
          row.push(null);
        } else {
          row.push(Number(token));
        }
      }

      if (line[index] === ",") {
        index += 1;
        continue;
      }

      if (line[index] === ")") {
        index += 1;
        yield row;
        break;
      }
    }
  }
}

export async function scanInsertRows(
  filePath: string,
  tableName: string,
  onRow: (row: SqlValue[]) => void,
  options?: {
    progressEveryRows?: number;
    onProgress?: (rows: number) => void;
  }
): Promise<void> {
  const prefix = `INSERT INTO \`${tableName}\` VALUES `;
  let rows = 0;
  for await (const line of iterateGzipLines(filePath)) {
    if (!line.startsWith(prefix)) {
      continue;
    }

    for (const row of parseInsertRows(line)) {
      onRow(row);
      rows += 1;
      if (
        options?.progressEveryRows &&
        options.onProgress &&
        rows % options.progressEveryRows === 0
      ) {
        options.onProgress(rows);
      }
    }
  }

  if (options?.onProgress) {
    options.onProgress(rows);
  }
}
