export const SLOT_ROWS = 3;
export const SLOT_COLUMNS = 3;
export const SLOT_PLACEHOLDER = "❔";
const SLOT_CELL_COUNT = SLOT_ROWS * SLOT_COLUMNS;

export type SlotGrid = string[][];
export type SlotPosition = readonly [row: number, column: number];

export interface PaylineDefinition {
  key: string;
  displayName: string;
  positions: readonly [SlotPosition, SlotPosition, SlotPosition];
}

export interface WinningPayline {
  key: string;
  displayName: string;
  symbol: string;
}

export interface ProbabilityFraction {
  numerator: bigint;
  denominator: bigint;
}

export const PAYLINES: readonly PaylineDefinition[] = [
  {
    key: "row-top",
    displayName: "横1段目",
    positions: [
      [0, 0],
      [0, 1],
      [0, 2],
    ],
  },
  {
    key: "row-middle",
    displayName: "横2段目",
    positions: [
      [1, 0],
      [1, 1],
      [1, 2],
    ],
  },
  {
    key: "row-bottom",
    displayName: "横3段目",
    positions: [
      [2, 0],
      [2, 1],
      [2, 2],
    ],
  },
  {
    key: "column-left",
    displayName: "縦1列目",
    positions: [
      [0, 0],
      [1, 0],
      [2, 0],
    ],
  },
  {
    key: "column-middle",
    displayName: "縦2列目",
    positions: [
      [0, 1],
      [1, 1],
      [2, 1],
    ],
  },
  {
    key: "column-right",
    displayName: "縦3列目",
    positions: [
      [0, 2],
      [1, 2],
      [2, 2],
    ],
  },
  {
    key: "diag-down",
    displayName: "斜め↘",
    positions: [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
  },
  {
    key: "diag-up",
    displayName: "斜め↙",
    positions: [
      [0, 2],
      [1, 1],
      [2, 0],
    ],
  },
];

const PAYLINE_CELL_INDICES = PAYLINES.map((payline) =>
  payline.positions.map(([row, column]) => row * SLOT_COLUMNS + column),
);

const PAYLINE_SUBSET_COMPONENTS = Array.from({ length: 1 << PAYLINES.length }, (_, mask) =>
  countConnectedComponents(mask),
);

function validateGrid(grid: SlotGrid): void {
  if (grid.length !== SLOT_ROWS) {
    throw new Error(`Slot grid must have ${SLOT_ROWS} rows`);
  }

  if (grid.some((row) => row.length !== SLOT_COLUMNS)) {
    throw new Error(`Each slot grid row must have ${SLOT_COLUMNS} columns`);
  }
}

function countBits(value: number): number {
  let bits = value;
  let count = 0;
  while (bits > 0) {
    if ((bits & 1) === 1) {
      count += 1;
    }
    bits >>= 1;
  }
  return count;
}

function countConnectedComponents(mask: number): number {
  const parent = Array.from({ length: SLOT_CELL_COUNT }, (_, index) => index);

  const find = (value: number): number => {
    let current = value;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!;
      current = parent[current]!;
    }
    return current;
  };

  const union = (left: number, right: number): void => {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft === rootRight) {
      return;
    }
    parent[rootRight] = rootLeft;
  };

  PAYLINE_CELL_INDICES.forEach((line, lineIndex) => {
    if ((mask & (1 << lineIndex)) === 0) {
      return;
    }

    const [a, b, c] = line;
    union(a!, b!);
    union(a!, c!);
  });

  const roots = new Set<number>();
  for (let cell = 0; cell < SLOT_CELL_COUNT; cell += 1) {
    roots.add(find(cell));
  }

  return roots.size;
}

function randomIndex(maxExclusive: number, random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) {
    throw new Error("Random function must return a finite number");
  }

  const normalized = Math.min(Math.max(value, 0), 0.9999999999999999);
  return Math.floor(normalized * maxExclusive);
}

export function createSlotGrid(emojiPool: readonly string[], random: () => number = Math.random): SlotGrid {
  if (emojiPool.length === 0) {
    throw new Error("Emoji pool must not be empty");
  }

  const grid: SlotGrid = [];
  for (let row = 0; row < SLOT_ROWS; row += 1) {
    const nextRow: string[] = [];
    for (let column = 0; column < SLOT_COLUMNS; column += 1) {
      const index = randomIndex(emojiPool.length, random);
      nextRow.push(emojiPool[index] ?? emojiPool[emojiPool.length - 1]!);
    }
    grid.push(nextRow);
  }

  return grid;
}

export function createRevealGrid(
  finalGrid: SlotGrid,
  revealedColumns: number,
  placeholder = SLOT_PLACEHOLDER,
): SlotGrid {
  validateGrid(finalGrid);
  const clampedColumns = Math.min(SLOT_COLUMNS, Math.max(0, Math.trunc(revealedColumns)));

  return finalGrid.map((row) =>
    row.map((cell, column) => {
      if (column < clampedColumns) {
        return cell;
      }

      return placeholder;
    }),
  );
}

export function findWinningPaylines(grid: SlotGrid): WinningPayline[] {
  validateGrid(grid);

  return PAYLINES.flatMap((payline) => {
    const [a, b, c] = payline.positions.map(([row, column]) => grid[row]?.[column] ?? "");
    if (a === "" || a !== b || b !== c) {
      return [];
    }

    return [
      {
        key: payline.key,
        displayName: payline.displayName,
        symbol: a,
      },
    ];
  });
}

export function formatSlotGrid(grid: SlotGrid): string {
  validateGrid(grid);
  return grid.map((row) => row.join(" ")).join("\n");
}

export function calculateWinProbability(emojiCount: number): ProbabilityFraction {
  if (!Number.isInteger(emojiCount) || emojiCount <= 0) {
    throw new Error("emojiCount must be a positive integer");
  }

  const symbolCount = BigInt(emojiCount);
  const denominator = symbolCount ** BigInt(SLOT_CELL_COUNT);
  let numerator = 0n;

  for (let mask = 1; mask < PAYLINE_SUBSET_COMPONENTS.length; mask += 1) {
    const components = PAYLINE_SUBSET_COMPONENTS[mask]!;
    const term = symbolCount ** BigInt(components);

    if (countBits(mask) % 2 === 1) {
      numerator += term;
    } else {
      numerator -= term;
    }
  }

  return { numerator, denominator };
}

export function formatProbabilityPercent(probability: ProbabilityFraction, decimals = 4): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error("decimals must be a non-negative integer");
  }

  if (probability.denominator <= 0n) {
    throw new Error("denominator must be greater than zero");
  }

  const scale = 10n ** BigInt(decimals);
  const scaled = probability.numerator * 100n * scale;
  const rounded = (scaled * 2n + probability.denominator) / (2n * probability.denominator);

  if (decimals === 0) {
    return `${rounded.toString()}%`;
  }

  const integerPart = rounded / scale;
  const fractionPart = rounded % scale;
  return `${integerPart.toString()}.${fractionPart.toString().padStart(decimals, "0")}%`;
}
