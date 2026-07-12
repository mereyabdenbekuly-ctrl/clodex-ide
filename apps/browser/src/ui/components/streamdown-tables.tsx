import posthog from 'posthog-js';
import {
  memo,
  useState,
  useRef,
  useCallback,
  type DetailedHTMLProps,
  type TableHTMLAttributes,
  type HTMLAttributes,
  type ThHTMLAttributes,
  type TdHTMLAttributes,
} from 'react';
import type { ExtraProps } from 'react-markdown';
import { cn } from '@ui/utils';
import { Button } from '@clodex/stage-ui/components/button';
import { CopyIcon, CopyCheckIcon, DownloadIcon } from 'lucide-react';

// ============================================
// Table Wrapper with Custom Controls
// ============================================

type TableProps = DetailedHTMLProps<
  TableHTMLAttributes<HTMLTableElement>,
  HTMLTableElement
> &
  ExtraProps;

const TableComponent = ({ className, children, ...props }: TableProps) => {
  const tableRef = useRef<HTMLTableElement>(null);
  const [hasCopied, setHasCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  const getTableData = useCallback(() => {
    if (!tableRef.current)
      return { headers: [] as string[], rows: [] as string[][] };

    const headers: string[] = [];
    const rows: string[][] = [];

    const headerCells = tableRef.current.querySelectorAll('thead th');
    headerCells.forEach((cell) => headers.push(cell.textContent ?? ''));

    const bodyRows = tableRef.current.querySelectorAll('tbody tr');
    bodyRows.forEach((row) => {
      const rowData: string[] = [];
      row
        .querySelectorAll('td')
        .forEach((cell) => rowData.push(cell.textContent ?? ''));
      rows.push(rowData);
    });

    return { headers, rows };
  }, []);

  const toCSV = useCallback((data: { headers: string[]; rows: string[][] }) => {
    const escapeCell = (cell: string) => {
      if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
        return `"${cell.replace(/"/g, '""')}"`;
      }
      return cell;
    };
    return [
      data.headers.map(escapeCell).join(','),
      ...data.rows.map((row) => row.map(escapeCell).join(',')),
    ].join('\n');
  }, []);

  const copyAsCSV = useCallback(async () => {
    const data = getTableData();
    const csvContent = toCSV(data);

    try {
      await navigator.clipboard.writeText(csvContent);
      setHasCopied(true);
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = window.setTimeout(
        () => setHasCopied(false),
        2000,
      );
    } catch (err) {
      console.error('Failed to copy table:', err);
      posthog.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { source: 'renderer', operation: 'copyTableCSV' },
      );
    }
  }, [getTableData, toCSV]);

  const downloadAsCSV = useCallback(() => {
    const data = getTableData();
    const csvContent = toCSV(data);

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'table.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [getTableData, toCSV]);

  return (
    <div className="my-3 flex flex-col gap-1.5" data-streamdown="table-wrapper">
      {/* Custom Controls */}
      <div className="flex items-center justify-end gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={copyAsCSV}
          title="Copy table as CSV"
        >
          {hasCopied ? (
            <CopyCheckIcon className="size-3" />
          ) : (
            <CopyIcon className="size-3" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={downloadAsCSV}
          title="Download as CSV"
        >
          <DownloadIcon className="size-3" />
        </Button>
      </div>

      {/* Table Container with horizontal scroll */}
      <div className="scrollbar-subtle overflow-x-auto rounded-md border border-derived bg-background">
        <table
          ref={tableRef}
          className={cn('w-full border-collapse', className)}
          data-streamdown="table"
          {...props}
        >
          {children}
        </table>
      </div>
    </div>
  );
};

export const MemoTable = memo(TableComponent);
MemoTable.displayName = 'MarkdownTable';

// ============================================
// Table Head
// ============================================

type TheadProps = DetailedHTMLProps<
  HTMLAttributes<HTMLTableSectionElement>,
  HTMLTableSectionElement
> &
  ExtraProps;

const TheadComponent = ({ className, children, ...props }: TheadProps) => (
  <thead
    className={cn('bg-muted/60', className)}
    data-streamdown="table-header"
    {...props}
  >
    {children}
  </thead>
);

export const MemoThead = memo(TheadComponent);
MemoThead.displayName = 'MarkdownThead';

// ============================================
// Table Body
// ============================================

type TbodyProps = DetailedHTMLProps<
  HTMLAttributes<HTMLTableSectionElement>,
  HTMLTableSectionElement
> &
  ExtraProps;

const TbodyComponent = ({ className, children, ...props }: TbodyProps) => (
  <tbody
    className={cn('divide-y divide-derived', className)}
    data-streamdown="table-body"
    {...props}
  >
    {children}
  </tbody>
);

export const MemoTbody = memo(TbodyComponent);
MemoTbody.displayName = 'MarkdownTbody';

// ============================================
// Table Row
// ============================================

type TrProps = DetailedHTMLProps<
  HTMLAttributes<HTMLTableRowElement>,
  HTMLTableRowElement
> &
  ExtraProps;

const TrComponent = ({ className, children, ...props }: TrProps) => (
  <tr
    className={cn('border-derived border-b last:border-b-0', className)}
    data-streamdown="table-row"
    {...props}
  >
    {children}
  </tr>
);

export const MemoTr = memo(TrComponent);
MemoTr.displayName = 'MarkdownTr';

// ============================================
// Table Header Cell
// ============================================

type ThProps = DetailedHTMLProps<
  ThHTMLAttributes<HTMLTableCellElement>,
  HTMLTableCellElement
> &
  ExtraProps;

const ThComponent = ({ className, children, ...props }: ThProps) => (
  <th
    className={cn(
      'whitespace-nowrap px-3 py-1.5 text-left font-medium text-xs',
      className,
    )}
    data-streamdown="table-header-cell"
    {...props}
  >
    {children}
  </th>
);

export const MemoTh = memo(ThComponent);
MemoTh.displayName = 'MarkdownTh';

// ============================================
// Table Data Cell
// ============================================

type TdProps = DetailedHTMLProps<
  TdHTMLAttributes<HTMLTableCellElement>,
  HTMLTableCellElement
> &
  ExtraProps;

const TdComponent = ({ className, children, ...props }: TdProps) => (
  <td
    className={cn('px-3 py-1.5 text-xs', className)}
    data-streamdown="table-cell"
    {...props}
  >
    {children}
  </td>
);

export const MemoTd = memo(TdComponent);
MemoTd.displayName = 'MarkdownTd';
