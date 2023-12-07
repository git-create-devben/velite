import * as z from '../zod'
import { ZodMeta } from '../zod'
import { excerpt } from './excerpt'
import { file } from './file'
import { image } from './image'
import { isodate } from './isodate'
import { markdown } from './markdown'
import { mdx } from './mdx'
import { metadata } from './metadata'
import { slug } from './slug'
import { summary } from './summary'
import { unique } from './unique'

declare module '../zod' {
  interface ZodMeta {
    file: import('vfile').VFile
    config: import('../config').Config
  }
}

export const s = {
  ...z,
  isodate,
  unique,
  slug,
  file,
  image,
  metadata,
  summary,
  excerpt,
  markdown,
  mdx
}

export type * from '../zod'
export type * from './markdown'
export type * from './mdx'
