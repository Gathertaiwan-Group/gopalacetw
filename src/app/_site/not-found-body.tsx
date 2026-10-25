import { Raw } from "@/components/Raw";
import { notFoundMain } from "@/theme/render";

export default function NotFound() {
  return <Raw as="main" id="main" className="site-main hfeed" itemscope itemtype="https://schema.org/CreativeWork" html={notFoundMain()} />;
}
