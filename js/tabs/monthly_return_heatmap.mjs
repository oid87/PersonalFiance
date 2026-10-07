// Presentation only. Caller supplies previously calculated percentage returns.
// No daily/monthly return calculation, endpoint inference, fill or aggregation.
export function monthlyReturnHeatmapModel(rows) {
  if (!Array.isArray(rows)) throw new Error('Monthly return rows must be an array');
  const byMonth = new Map();
  for (const row of rows) {
    if (!row || typeof row.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month)
      || !(row.returnPct === null || Number.isFinite(row.returnPct))
      || typeof row.partial !== 'boolean'
      || ![row.from, row.to].every(value => value == null || typeof value === 'string')) {
      throw new Error('Invalid monthly return presentation row');
    }
    if (byMonth.has(row.month)) throw new Error(`Duplicate monthly return: ${row.month}`);
    byMonth.set(row.month, { month: row.month, returnPct: row.returnPct,
      partial: row.partial, from: row.from ?? null, to: row.to ?? null });
  }
  const years = [...new Set([...byMonth.keys()].map(month => month.slice(0, 4)))].sort();
  const cells = years.flatMap((year, yearIndex) => Array.from({ length: 12 }, (_, monthIndex) => {
    const month = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const row = byMonth.get(month);
    return { month, x: monthIndex, y: yearIndex, returnPct: row?.returnPct ?? null,
      partial: row?.partial ?? null, from: row?.from ?? null, to: row?.to ?? null,
      provided: Boolean(row) };
  }));
  return { years, cells };
}

export function monthlyReturnHeatmapOption(model, { colors, calculationLabel }) {
  if (!colors || typeof calculationLabel !== 'string' || !calculationLabel.trim()) {
    throw new Error('Caller must provide theme colors and the confirmed calculation label');
  }
  // Color extent is derived from supplied values; it is not a risk threshold.
  const bound = Math.max(1, ...model.cells.filter(cell => cell.returnPct !== null)
    .map(cell => Math.abs(cell.returnPct)));
  const format = cell => cell.returnPct === null ? '—'
    : `${cell.returnPct.toFixed(2)}%${cell.partial ? '（未完整）' : ''}`;
  return {
    backgroundColor: 'transparent',
    animation: false,
    aria: { enabled: true, description: calculationLabel },
    grid: { top: 30, left: 60, right: 20, bottom: 80 },
    xAxis: { type: 'category', data: Array.from({ length: 12 }, (_, index) => `${index + 1}月`),
      axisLabel: { color: colors.text } },
    yAxis: { type: 'category', data: model.years, axisLabel: { color: colors.text } },
    visualMap: { min: -bound, max: bound, calculable: false, orient: 'horizontal',
      left: 'center', bottom: 0, dimension: 2,
      inRange: { color: [colors.negative, colors.neutral, colors.positive] },
      textStyle: { color: colors.text } },
    tooltip: {
      trigger: 'item', renderMode: 'richText',
      formatter: params => {
        const cell = params.data.cell;
        return `${cell.month}: ${format(cell)}\n${calculationLabel}\n${cell.from ?? '—'} → ${cell.to ?? '—'}`;
      },
    },
    series: [{ type: 'heatmap',
      data: model.cells.map(cell => ({ value: [cell.x, cell.y, cell.returnPct], cell })),
      label: { show: true, color: colors.text, formatter: params => format(params.data.cell) },
      itemStyle: { borderWidth: 1, borderColor: colors.border },
    }],
  };
}
