import { describe, expect, it } from "vitest";
import {
  PAYLINES,
  calculateWinProbability,
  createRevealGrid,
  createSlotGrid,
  findWinningPaylines,
  formatProbabilityPercent,
  formatSlotGrid,
  type SlotGrid,
} from "../src/spin.js";

function sequenceRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    return value ?? 0;
  };
}

function gridFromLinear(cells: readonly string[]): SlotGrid {
  return [
    [cells[0]!, cells[1]!, cells[2]!],
    [cells[3]!, cells[4]!, cells[5]!],
    [cells[6]!, cells[7]!, cells[8]!],
  ];
}

function bruteForceWinProbability(emojiCount: number): { numerator: bigint; denominator: bigint } {
  const symbols = Array.from({ length: emojiCount }, (_, index) => `${index}`);
  const cellCount = 9;
  const current = new Array<string>(cellCount);
  let wins = 0n;

  const walk = (index: number): void => {
    if (index === cellCount) {
      if (findWinningPaylines(gridFromLinear(current)).length > 0) {
        wins += 1n;
      }
      return;
    }

    symbols.forEach((symbol) => {
      current[index] = symbol;
      walk(index + 1);
    });
  };

  walk(0);
  return {
    numerator: wins,
    denominator: BigInt(emojiCount) ** 9n,
  };
}

describe("createSlotGrid", () => {
  it("always returns a 3x3 grid made of provided emojis", () => {
    const emojiPool = ["A", "B", "C"];
    const grid = createSlotGrid(emojiPool);

    expect(grid).toHaveLength(3);
    expect(grid.every((row) => row.length === 3)).toBe(true);
    expect(grid.flat().every((cell) => emojiPool.includes(cell))).toBe(true);
  });

  it("supports deterministic generation via injected RNG", () => {
    const emojiPool = ["A", "B", "C"];
    const rng = sequenceRandom([0, 0.5, 0.99, 0, 0.5, 0.99, 0, 0.5, 0.99]);

    const grid = createSlotGrid(emojiPool, rng);
    expect(grid).toEqual([
      ["A", "B", "C"],
      ["A", "B", "C"],
      ["A", "B", "C"],
    ]);
  });
});

describe("findWinningPaylines", () => {
  it("detects horizontal winning lines", () => {
    const grid: SlotGrid = [
      ["X", "X", "X"],
      ["A", "B", "C"],
      ["D", "E", "F"],
    ];

    const winners = findWinningPaylines(grid);
    expect(winners.map((winner) => winner.key)).toContain("row-top");
  });

  it("detects vertical winning lines", () => {
    const grid: SlotGrid = [
      ["Z", "A", "B"],
      ["Z", "C", "D"],
      ["Z", "E", "F"],
    ];

    const winners = findWinningPaylines(grid);
    expect(winners.map((winner) => winner.key)).toContain("column-left");
  });

  it("detects diagonal winning lines", () => {
    const grid: SlotGrid = [
      ["Q", "A", "Q"],
      ["B", "Q", "C"],
      ["Q", "D", "Q"],
    ];

    const winners = findWinningPaylines(grid);
    const keys = winners.map((winner) => winner.key);
    expect(keys).toContain("diag-up");
    expect(keys).toContain("diag-down");
  });

  it("detects multiple winning lines at once", () => {
    const grid: SlotGrid = [
      ["J", "J", "J"],
      ["J", "J", "J"],
      ["J", "J", "J"],
    ];

    const winners = findWinningPaylines(grid);
    expect(winners).toHaveLength(PAYLINES.length);
  });

  it("returns no winners when there are no matches", () => {
    const grid: SlotGrid = [
      ["A", "B", "C"],
      ["D", "E", "F"],
      ["G", "H", "I"],
    ];

    expect(findWinningPaylines(grid)).toEqual([]);
  });
});

describe("createRevealGrid", () => {
  const finalGrid: SlotGrid = [
    ["A", "B", "C"],
    ["D", "E", "F"],
    ["G", "H", "I"],
  ];

  it("keeps hidden columns masked until they are revealed", () => {
    expect(createRevealGrid(finalGrid, 0, "?")).toEqual([
      ["?", "?", "?"],
      ["?", "?", "?"],
      ["?", "?", "?"],
    ]);

    expect(createRevealGrid(finalGrid, 1, "?")).toEqual([
      ["A", "?", "?"],
      ["D", "?", "?"],
      ["G", "?", "?"],
    ]);

    expect(createRevealGrid(finalGrid, 2, "?")).toEqual([
      ["A", "B", "?"],
      ["D", "E", "?"],
      ["G", "H", "?"],
    ]);
  });

  it("matches final grid after all columns are revealed", () => {
    expect(createRevealGrid(finalGrid, 3, "?")).toEqual(finalGrid);
  });
});

describe("formatSlotGrid", () => {
  it("formats a grid as three display lines", () => {
    const grid: SlotGrid = [
      ["A", "B", "C"],
      ["D", "E", "F"],
      ["G", "H", "I"],
    ];

    expect(formatSlotGrid(grid)).toBe("A B C\nD E F\nG H I");
  });
});

describe("calculateWinProbability", () => {
  it("is always 100% when the guild has only one custom emoji", () => {
    const probability = calculateWinProbability(1);
    expect(probability).toEqual({ numerator: 1n, denominator: 1n });
  });

  it("matches brute-force results for two symbols", () => {
    const exact = calculateWinProbability(2);
    const bruteForce = bruteForceWinProbability(2);
    expect(exact).toEqual(bruteForce);
  });

  it("matches brute-force results for three symbols", () => {
    const exact = calculateWinProbability(3);
    const bruteForce = bruteForceWinProbability(3);
    expect(exact).toEqual(bruteForce);
  });
});

describe("formatProbabilityPercent", () => {
  it("formats percentage with four decimals", () => {
    const value = formatProbabilityPercent({ numerator: 1n, denominator: 8n }, 4);
    expect(value).toBe("12.5000%");
  });
});
