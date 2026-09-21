/**
 * One step of the answer pipeline. Each stage owns exactly one port, so a
 * model or provider swap stays behind that port and never touches the
 * orchestration in AnswerService.
 */
export interface PipelineStage<In, Out> {
  run(input: In): Promise<Out>;
}
