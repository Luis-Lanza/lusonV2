/** Presentation only: API timestamps, including nanoseconds, remain untouched. */
export default function TransferDate({ value }: { value?: string | null }) {
  // Require an explicit offset; date-only/local strings would depend on the device.
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
  let date: Date | null = null;
  if (match) {
    const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    // Date.parse normalizes some impossible dates, so check the calendar first.
    if (month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]) {
      // Only the display copy is reduced to milliseconds for cross-browser parsing.
      const parsed = new Date(value!.replace(/\.(\d{3})\d+/, '.$1'));
      if (Number.isFinite(parsed.getTime())) date = parsed;
    }
  }
  if (!date) return <span title={value || undefined}>Fecha no disponible</span>;
  const parts = new Intl.DateTimeFormat('es-BO', {
    timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value;
  // Construct separators deliberately, independent of locale punctuation changes.
  return <time dateTime={value!} title={value!}>
    {`${part('day')}/${part('month')}/${part('year')} · ${part('hour')}:${part('minute')} (hora Bolivia)`}
  </time>;
}
