import { defineCollection } from "astro:content";

import { glob } from "astro/loaders";

import { z } from "astro/zod";

const blog = defineCollection({
  // Load Markdown and MDX files in the 'src/content/blog/ directory.

  loader: glob({ base: "./src/content/blog", pattern: "**/*.{md,mdx}" }),

  // Type-check frontmatter using a schema

  schema: ({ image }) =>
    z.object({
      title: z.string(),

      description: z.string(),

      // Transform string to Date object

      pubDate: z.coerce.date(),

      updatedDate: z.coerce.date().optional(),

      heroImage: z.optional(image()),
    }),
});

const projects = defineCollection({
  // Load Markdown and MDX files in the 'src/content/projects/ directory. loader: glob({ base: './src/content/projects', pattern: '**/*.{md,mdx} }),
  loader: glob({ base: "./src/content/projects", pattern: "**/*.{md,mdx}" }),

  schema: z.object({
    title: z.string(),

    description: z.string(),

    skills: z.array(z.string()).min(1),

    order: z.number().default(0),
  }),
});

export const collections = { blog, projects };
