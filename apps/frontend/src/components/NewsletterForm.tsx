import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { api } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";

const schema = z.object({
  email: z.email("Please enter a valid email address."),
});

type FormValues = z.infer<typeof schema>;

export default function NewsletterForm() {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "" },
  });

  async function onSubmit(data: FormValues) {
    try {
      const res = await api.newsletter.subscribe.$post({ json: data });
      const body = await res.json();

      if (body.success) {
        toast.success(body.message, { id: "newsletter-subscription" });
        form.reset();
      } else {
        const message =
          typeof body.error === "string"
            ? body.error
            : "Please enter a valid email address.";
        toast.error(message, { id: "newsletter-subscription" });
      }
    } catch {
      toast.error("Network error. Please try again.", {
        id: "newsletter-subscription",
      });
    }
  }

  return (
    <div className="mx-auto max-w-md rounded-3xl bg-white p-5 text-center ring-1 ring-black/5">
      <h3 className="text-base font-semibold text-ink/90 mb-1">Stay updated</h3>
      <p className="text-sm text-muted-foreground mb-4">
        Get notified about new features and service announcements.
      </p>
      <Form {...form}>
        <form
          onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
          noValidate
        >
          <div className="flex gap-2 max-w-md mx-auto">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormControl>
                    <Input
                      {...field}
                      type="email"
                      placeholder="your@email.com"
                      shape="pill"
                      className="h-11"
                    />
                  </FormControl>
                  <FormMessage className="-mt-1 text-left" />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              size="pill-lg"
              disabled={form.formState.isSubmitting}
              className="h-11"
            >
              {form.formState.isSubmitting ? "Subscribing..." : "Subscribe"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
