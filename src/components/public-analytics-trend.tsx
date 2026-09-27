import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

type Trend = { label: string; requests: number; tokens: number; costMicros: number };

export function PublicUsageTrend({ trend }: { trend: Trend[] }) {
  return <Card>
    <CardHeader><CardTitle>Usage trend</CardTitle><CardDescription>Requests and cost for the selected range.</CardDescription></CardHeader>
    <CardContent>
      <ChartContainer config={{ requests: { label: "Requests" }, costMicros: { label: "Cost (USD micros)" } }} className="h-64 w-full">
        <AreaChart data={trend} margin={{ left: 8, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} />
          <YAxis yAxisId="requests" tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis yAxisId="cost" orientation="right" tickLine={false} axisLine={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Area yAxisId="requests" type="monotone" dataKey="requests" fill="var(--color-requests)" fillOpacity={0.2} stroke="var(--color-requests)" />
          <Area yAxisId="cost" type="monotone" dataKey="costMicros" fill="var(--color-costMicros)" fillOpacity={0.12} stroke="var(--color-costMicros)" />
        </AreaChart>
      </ChartContainer>
    </CardContent>
  </Card>;
}
