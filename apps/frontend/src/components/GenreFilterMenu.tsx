import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";

function summary(selected: string[], empty: string) {
  if (selected.length === 0) return empty;
  if (selected.length <= 2) return selected.join(", ");
  return `${selected.length} genres`;
}

/** A menu that picks any number of genres, for one genre filter of a List. */
export default function GenreFilterMenu({
  id,
  label,
  empty,
  hint,
  genres,
  selected,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  empty: string;
  hint: string;
  genres: string[];
  selected: string[];
  disabled: boolean;
  onChange: (genres: string[]) => void;
}) {
  const options = [...new Set([...genres, ...selected])].sort((a, b) =>
    a.localeCompare(b),
  );
  return (
    <div className="min-w-0">
      <Label htmlFor={id} variant="caption" className="mb-1">
        {label}
      </Label>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            id={id}
            type="button"
            className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-white px-3 py-2 text-left text-sm whitespace-nowrap shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-ring"
          >
            <span className="truncate">{summary(selected, empty)}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground opacity-50" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-72 w-(--radix-dropdown-menu-trigger-width)"
        >
          <p className="px-2 pt-1 pb-1.5 text-2xs leading-snug text-muted-foreground">
            {hint}
          </p>
          {selected.length > 0 && (
            <DropdownMenuItem onSelect={() => onChange([])}>
              {empty}
            </DropdownMenuItem>
          )}
          {options.map((genre) => (
            <DropdownMenuCheckboxItem
              key={genre}
              checked={selected.includes(genre)}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                onChange(
                  checked
                    ? [...selected, genre]
                    : selected.filter((entry) => entry !== genre),
                )
              }
            >
              {genre}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
