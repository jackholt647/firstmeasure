package ai.firstmeasure.mobile;
import org.junit.Test;
import java.util.Arrays;
import static org.junit.Assert.*;
public class CameraZoomRangeTest {
 @Test public void separateUltrawideAndTelephotoUseOneZoomScale(){
  var ranges=Arrays.asList(new CameraZoomRange(1,1,10),new CameraZoomRange(.5,1,8),new CameraZoomRange(3,1,10));
  assertEquals(1,CameraZoomRange.select(ranges,.5));assertEquals(1,ranges.get(1).local(.5),.001);
  assertEquals(0,CameraZoomRange.select(ranges,1));assertEquals(2,CameraZoomRange.select(ranges,3));
  assertEquals(2,CameraZoomRange.select(ranges,30));assertEquals(10,ranges.get(2).local(30),.001);
 }
 @Test public void logicalCameraRetainsSupportedZoomOut(){
  var ranges=Arrays.asList(new CameraZoomRange(1,.5,30),new CameraZoomRange(.5,1,8));
  assertEquals(0,CameraZoomRange.select(ranges,.5));assertEquals(.5,ranges.get(0).local(.5),.001);
 }
 @Test public void clampsRequestsAndUsesActualNonstandardRatios(){
  var range=new CameraZoomRange(.6,1,7);assertEquals(.6,range.min,.001);assertEquals(4.2,range.max,.001);
  assertEquals(1,range.local(.5),.001);assertEquals(7,range.local(30),.001);
 }
}
