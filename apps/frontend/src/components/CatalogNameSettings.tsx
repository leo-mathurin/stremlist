import { useId } from "react";
import { CATALOG_NAME_PREFIX } from "@stremlist/shared/manifest-catalogs";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

/** The Account choice to start every Catalog name with "Stremlist". */
export default function CatalogNameSettings({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (prefix: boolean) => void;
}) {
  const id = useId();
  return (
    <div>
      <p className="font-bold">Catalog names</p>
      <div className="mt-2 flex items-start gap-2.5">
        <Checkbox
          id={id}
          aria-describedby={`${id}-help`}
          checked={value}
          onCheckedChange={(next) => onChange(next === true)}
          className="mt-0.5"
        />
        <div>
          <Label htmlFor={id} variant="plain" className="cursor-pointer">
            Start catalog names with {CATALOG_NAME_PREFIX}
          </Label>
          <p id={`${id}-help`} className="mt-0.5 text-sm text-black/55">
            {value
              ? `Stremio shows "${CATALOG_NAME_PREFIX} Watchlist".`
              : 'Stremio shows "Watchlist".'}{" "}
            Reinstall after you change this option.
          </p>
        </div>
      </div>
    </div>
  );
}
