import { redirect } from 'next/navigation'

// The scout table is the tool; there is no dashboard worth stopping at on the way to it.
export default function Home() {
  redirect('/scout')
}
