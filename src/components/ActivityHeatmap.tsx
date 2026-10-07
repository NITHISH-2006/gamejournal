import { useMemo } from 'react';
import { getActivityHeatmap, type HeatmapDay } from '@/app/actions/stats';
import { formatMonthYear } from '@/lib/date';

/**
 * Contribution-style activity grid.
 *
 * The streaks in `StatsPanel` answer "how long is my current run". That is a
 * single number, and it is the wrong shape for the question players actually
 * ask, which is a *pattern*: do I play more at weekends, did I fall off in March,
 * was that one week a whole month.
 *
 * The grid is rendered server-side, so it needs no client JavaScript and is in
 * the initial HTML.
 *
 * Renders nothing when the RPC is unavailable. An empty grid would read as "this
 * player has never logged anything", which is a different and false statement
 * from "this feature is not installed".
 */
export default async function ActivityHeatmap({
  userId,
  weeks = 26,
}: {
  userId: string;
  weeks?: number;
}) {
  const days = await getActivityHeatmap(userId, weeks * 7).catch(() => null);

  if (!days || days.length === 0) return null;

  return (
    <section aria-labelledby="heatmap-heading" className="mb-6">
      <h3 id="heatmap-heading" className="mb-2 text-sm font-semibold">
        Activity
      </h3>
      <HeatmapGrid days={days} weeks={weeks} />
      <HeatmapLegend />
    </section>
  );
}

/**
 * Buckets activity into five levels.
 *
 * Thresholds are derived from the user's own maximum rather than fixed, because
 * a fixed scale makes an infrequent player see an entirely empty grid â€” which
 * reads as inactivity rather than as a quiet but real pattern.
 */
function bucketFor(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (max <= 1) return 4;
  const ratio = value / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

const LEVEL_CLASS: Record<number, string> = {
  0: 'bg-white/5',
  1: 'bg-brand/25',
  2: 'bg-brand/45',
  3: 'bg-brand/70',
  4: 'bg-brand',
};

function HeatmapGrid({ days, weeks }: { days: HeatmapDay[]; weeks: number }) {
  const { columns, months, max } = useMemo(() => {
    const peak = Math.max(...days.map((d) => d.logs), 0);

    // Pad the front so the first column starts on a Sunday, otherwise the grid
    // silently shifts every row by however many days are missing at the front.
    const first = new Date(`${days[0].day}T00:00:00Z`);
    const leadingBlanks = first.getUTCDay();

    const cells: { day: string | null; level: number; logs: number }[] = [];
    for (let i = 0; i < leadingBlanks; i++) {
      cells.push({ day: null, level: -1, logs: 0 });
    }
    for (const d of days) {
      cells.push({ day: d.day, level: bucketFor(d.logs, peak), logs: d.logs });
    }

    // Group into week columns (7 cells each).
    const cols: typeof cells[] = [];
    for (let i = 0; i < cells.length; i += 7) cols.push(cells.slice(i, i + 7));

    // A month label on the first column that starts a new month.
    const labels: { index: number; label: string }[] = [];
    let lastMonth = -1;
    cols.forEach((col, i) => {
      const day = col.find((c) => c.day);
      if (!day) return;
      const d = new Date(`${day.day}T00:00:00Z`);
      if (d.getUTCMonth() !== lastMonth) {
        lastMonth = d.getUTCMonth();
        labels.push({ index: i, label: formatMonthYear(d) });
      }
    });

    return { columns: cols, months: labels, max: peak };
  }, [days]);

  return (
    <div className="overflow-x-auto pb-1">
      <div className="inline-flex min-w-full flex-col gap-1">
        {/* Month labels */}
        <div className="flex h-4 gap-[3px] pl-[14px]" aria-hidden="true">
          {columns.map((_, i) => {
            const label = months.find((m) => m.index === i);
            return (
              <span
                key={i}
                className="w-[11px] shrink-0 text-[9px] leading-4 text-ink-faint"
              >
                {label ? label.label.split(' ')[0]?.slice(0, 3) : ''}
              </span>
            );
          })}
        </div>

        <div className="flex gap-[3px]">
          {/* Day-of-week gutter */}
          <div className="flex w-[11px] shrink-0 flex-col gap-[3px]" aria-hidden="true">
            {['', 'Mon', '', 'Wed', '', 'Fri', ''].map((d, i) => (
              <span
                key={i}
                className="h-[11px] text-[9px] leading-[11px] text-ink-faint"
              >
                {d}
              </span>
            ))}
          </div>

          {/* The grid */}
          <div
            className="flex gap-[3px]"
            role="img"
            aria-label={`Activity over the last ${weeks} weeks. Peak day: ${max} ${
              max === 1 ? 'log' : 'logs'
            }.`}
          >
            {columns.map((col, ci) => (
              <div key={ci} className="flex flex-col gap-[3px]">
                {col.map((cell, ri) =>
                  cell.day === null ? (
                    <span
                      key={ri}
                      className="size-[11px] rounded-[2px]"
                      aria-hidden="true"
                    />
                  ) : (
                    <span
                      key={ri}
                      className={`size-[11px] rounded-[2px] border border-black/20 ${LEVEL_CLASS[cell.level]}`}
                      title={
                        cell.logs === 0
                          ? `${cell.day}: no activity`
                          : `${cell.day}: ${cell.logs} ${cell.logs === 1 ? 'log' : 'logs'}`
                      }
                    />
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function HeatmapLegend() {
  return (
    <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-ink-faint">
      <span>Less</span>
      {[0, 1, 2, 3, 4].map((level) => (
        <span
          key={level}
          className={`size-[10px] rounded-[2px] border border-black/20 ${LEVEL_CLASS[level]}`}
          aria-hidden="true"
        />
      ))}
      <span>More</span>
    </div>
  );
}