import { Link } from "wouter";

export default function NotFound() {
  return (
    <main className="room-shell flex min-h-screen items-center justify-center px-5">
      <section className="notice-card max-w-md text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#1b7a7a]">404</p>
        <h1 className="mt-3 font-serif text-3xl text-[#20313c]">This room cannot be found.</h1>
        <p className="mt-3 text-sm leading-6 text-[#647982]">Check the link you received or create a new private room.</p>
        <Link href="/" className="mt-6 inline-flex rounded-full bg-[#1b7a7a] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#126667]">Back to CryptRoom</Link>
      </section>
    </main>
  );
}
