### Apply responsive flex layout with Tailwind CSS

Source: https://github.com/tailwindlabs/tailwindcss.com/blob/main/src/docs/responsive-design.mdx

Demonstrates how to create a responsive layout that switches from block display on mobile to flex display on medium screens and larger. Uses md:flex to enable flexbox at the medium breakpoint, md:shrink-0 to prevent image shrinking, and md:h-full md:w-48 to constrain image dimensions on larger screens.

```html
<div class="md:flex">
  <img class="md:shrink-0 md:h-full md:w-48" src="image.jpg" alt="Description" />
  <div>
    <p>Looking to take your team away on a retreat to enjoy awesome food and take in some sunshine? We have a list of places to do just that.</p>
  </div>
</div>
```

--------------------------------

### Create responsive grid layouts with breakpoint variants

Source: https://github.com/tailwindlabs/tailwindcss.com/blob/main/src/docs/hover-focus-and-other-states.mdx

Use Tailwind's responsive variants (md, lg, etc.) to apply different grid column counts at specific viewport breakpoints. This example renders a 3-column grid on mobile, 4 columns on medium screens, and 6 columns on large screens. Breakpoint variants enable mobile-first responsive design patterns.

```html
<div class="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
  <!-- ... -->
</div>
```

--------------------------------

### Apply Custom Tailwind CSS Breakpoints in HTML

Source: https://github.com/tailwindlabs/tailwindcss.com/blob/main/src/docs/responsive-design.mdx

This HTML snippet illustrates how to utilize custom breakpoints defined in your Tailwind CSS theme. Once breakpoints like `xs` and `3xl` are configured, you can apply responsive utility classes by prefixing them with the custom breakpoint name, such as `xs:grid-cols-2` or `3xl:grid-cols-6`, to control layout changes at specific screen sizes.

```html
<div class="grid xs:grid-cols-2 3xl:grid-cols-6">
  <!-- ... -->
</div>
```

--------------------------------

### Multi-column Layout with Tailwind CSS

Source: https://github.com/tailwindlabs/tailwindcss.com/blob/main/src/blog/tailwindcss-v3/index.mdx

Creates a responsive multi-column layout using Tailwind CSS columns utilities. The layout uses columns-1 on mobile devices and sm:columns-3 on small screens and above, with gap-6 spacing, justified text alignment, and serif font styling. This approach is useful for newspaper-style layouts and footer navigation designs.

```html
<div class="columns-1 sm:columns-3 gap-6 text-justify font-serif text-base">
  <p>...</p>
  <!-- Additional paragraphs -->
</div>
```

```jsx
<div className="relative columns-1 gap-6 text-justify font-serif text-base sm:columns-3">
  <p>
    Expedita quo ea quod laborum ullam ipsum enim. Deleniti commodi et. Nam id laborum placeat natus eum.
  </p>
  <p className="mt-6">
    Eligendi error nisi recusandae velit numquam nihil aperiam enim. Eum et molestias.
  </p>
</div>
```

--------------------------------

### Create mask position grid layout in Tailwind CSS

Source: https://github.com/tailwindlabs/tailwindcss.com/blob/main/src/docs/mask-position.mdx

Demonstrates a complete grid layout showcasing all mask position utilities (top-left, top, top-right, left, center, right, bottom-left, bottom, bottom-right). Uses a 3-column grid with responsive design and displays each mask position variant with labeled examples.

```jsx
<div className="grid grid-cols-3 gap-y-8 p-8 text-center font-mono text-xs font-medium text-gray-500 max-sm:items-end max-sm:justify-between max-sm:px-2 dark:text-gray-400">
  <div className="flex flex-col items-center">
    <p className="mb-3">mask-top-left</p>
    <Stripes className="aspect-[1.333] w-32 rounded-lg max-sm:w-24" border>
      <div className="h-full rounded-lg bg-[url(https://images.unsplash.com/photo-1554629947-334ff61d85dc?ixid=MnwxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8&ixlib=rb-1.2.1&auto=format&fit=crop&w=1000&h=1000&q=80)] mask-radial-from-70% mask-radial-to-70% bg-cover bg-center mask-size-[50%_66%] mask-top-left mask-no-repeat"></div>
    </Stripes>
  </div>
</div>
```
