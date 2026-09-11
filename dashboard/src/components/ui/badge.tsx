import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { Slot } from "radix-ui";
import type * as React from "react";

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 py-0.5 text-sm font-medium whitespace-nowrap transition-all focus-visible:border-ring has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "border-do/25 bg-do text-white [a]:hover:bg-do/90",
        secondary:
          "border-earth-ochre/35 bg-earth-ochre/20 text-earth-ochre [a]:hover:bg-earth-ochre/25",
        success: "border-do/35 bg-do/20 text-do [a]:hover:bg-do/25",
        warning:
          "border-earth-ochre/40 bg-earth-ochre/28 text-earth-ochre [a]:hover:bg-earth-ochre/35",
        info: "border-earth-slate/35 bg-earth-slate/18 text-earth-slate [a]:hover:bg-earth-slate/25",
        destructive:
          "border-destructive/35 bg-destructive/18 text-destructive [a]:hover:bg-destructive/25",
        outline:
          "border-earth-slate/25 bg-earth-slate/8 text-earth-slate [a]:hover:bg-earth-slate/15",
        ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
