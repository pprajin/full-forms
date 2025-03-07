import { ArrestDeclarationFormData, ArrestWarrantForm } from "./ArrestDeclaration";

export default async function ArrestDeclarationFormPage({
  params,
}: {
  params: {
    id: string;
  };
}) {
  const d = await (
    await fetch(
      `${process.env.NEXT_PUBLIC_CONVEX_HTTP_URL!}/get-data/${params.id}`,
      {
        next: {
          revalidate: 0,
        },
      }
    )
  ).json();

  return (
    <main>
      <ArrestWarrantForm
        id={params.id}
        data={d as ArrestDeclarationFormData}
      />
    </main>
  );
}
