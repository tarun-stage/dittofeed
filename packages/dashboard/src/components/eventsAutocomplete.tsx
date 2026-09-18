import { Autocomplete, SxProps, TextField, Theme } from "@mui/material";
import { useMemo } from "react";

import { usePropertiesQuery } from "../lib/usePropertiesQuery";

function filterCatalogOptions(
  options: string[],
  input: string,
  selected: string,
) {
  const search = (input || selected).trim().toLowerCase();
  return (
    search
      ? options.filter((option) => option.toLowerCase().includes(search))
      : options
  ).slice(0, 100);
}

export function PropertiesAutocomplete({
  disabled,
  sx,
  event,
  property,
  label = "Property Path",
  onPropertyChange,
}: {
  property: string;
  disabled?: boolean;
  sx?: SxProps<Theme>;
  event: string;
  label?: string;
  onPropertyChange: (property: string) => void;
}) {
  const { data: properties } = usePropertiesQuery();
  return (
    <Autocomplete
      value={property}
      disabled={disabled}
      freeSolo
      sx={sx}
      options={properties?.properties[event] ?? []}
      filterOptions={(options, { inputValue }) =>
        filterCatalogOptions(options, inputValue, property)
      }
      onChange={(_event, newValue) => {
        if (newValue === null) {
          onPropertyChange("");
          return;
        }

        let finalValue = newValue;
        // Format the value if it's a string containing a space
        if (typeof newValue === "string" && newValue.includes(" ")) {
          if (!newValue.startsWith('$["')) {
            finalValue = `$["${newValue}"]`;
          }
        }
        onPropertyChange(finalValue);
      }}
      onInputChange={(_event, newProperty) => {
        if (newProperty === undefined || newProperty === null) {
          return;
        }
        onPropertyChange(newProperty);
      }}
      renderInput={(params) => (
        <TextField label={label} {...params} variant="outlined" />
      )}
    />
  );
}

export function EventNamesAutocomplete({
  disabled,
  sx,
  event,
  label = "Event Name",
  onEventChange,
}: {
  disabled?: boolean;
  sx?: SxProps<Theme>;
  event: string;
  label?: string;
  onEventChange: (event: string) => void;
}) {
  const { data: properties } = usePropertiesQuery();
  const events = useMemo(
    () => Object.keys(properties?.properties ?? {}),
    [properties],
  );
  return (
    <Autocomplete
      value={event}
      disabled={disabled}
      freeSolo
      sx={sx}
      options={events ?? []}
      filterOptions={(options, { inputValue }) =>
        filterCatalogOptions(options, inputValue, event)
      }
      onInputChange={(_event, newEvent) => {
        if (newEvent === undefined || newEvent === null) {
          return;
        }
        onEventChange(newEvent);
      }}
      renderInput={(params) => (
        <TextField label={label} {...params} variant="outlined" />
      )}
    />
  );
}
