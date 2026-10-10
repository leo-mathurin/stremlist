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
  email: z.string().email("Please enter a valid email address."),
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
        toast.error(body.error, { id: "newsletter-subscription" });
      }
    } catch {
      toast.error("Network error. Please try again.", {
        id: "newsletter-subscription",
      });
    }
  }

  return (
    <div className="mx-auto max-w-md rounded-3xl bg-white p-5 text-center ring-1 ring-black/5">
      <h3 className="text-base font-semibold text-gray-800 mb-1">
        Stay updated
      </h3>
      <p className="text-sm text-gray-500 mb-4">
        Get notified about new features and service announcements.
      </p>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <div className="flex gap-2 max-w-md mx-auto">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem className="flex-1 gap-0">
                  <FormControl>
                    <Input
                      {...field}
                      type="email"
                      placeholder="your@email.com"
                      className="h-11 rounded-full bg-white px-4"
                    />
                  </FormControl>
                  <FormMessage className="text-left mt-1" />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              disabled={form.formState.isSubmitting}
              className="h-11 rounded-full bg-brand px-5 font-bold whitespace-nowrap text-black hover:bg-brand-dark"
            >
              {form.formState.isSubmitting ? "Subscribing..." : "Subscribe"}
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
