import type { ReactNode } from "react";
import { TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type DataTableColumn = {
  id: string;
  label: ReactNode;
  className?: string;
};

export function DataTableHeader({
  columns,
}: {
  columns: readonly DataTableColumn[];
}) {
  return (
    <TableHeader>
      <TableRow>
        {columns.map(({ id, label, className }) => (
          <TableHead key={id} className={className}>
            {label}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  );
}
