export interface WatchlistData {
  metas: StremioMeta[]
}

export interface StremioMeta {
  id: string
  name: string
  poster: string | null
  posterShape: "poster" | "square" | "landscape"
  type: "movie" | "series"
  genres: string[]
  description: string
  imdbRating?: string
  releaseInfo?: string
  director?: string[]
  cast?: string[]
  runtime?: string
}

export interface StremioCatalog {
  id: string
  name: string
  type: "movie" | "series"
}

export interface StremioResource {
  name: string
  types: string[]
  idPrefixes?: string[]
}

export interface StremioConfigOption {
  key: string
  type: "select" | "text" | "checkbox"
  title: string
  options?: string[]
  default?: string
}

export interface StremioManifest {
  id: string
  version: string
  name: string
  description: string
  resources: (string | StremioResource)[]
  types: string[]
  catalogs: StremioCatalog[]
  logo: string
  behaviorHints: {
    configurable: boolean
    configurationRequired: boolean
  }
  config?: StremioConfigOption[]
  selfUrl?: string
}
