package ai.firstmeasure.mobile;
import org.junit.Test;
import static org.junit.Assert.*;
public class OriginPolicyTest {
    @Test public void exactOriginOnly() {
        OriginPolicy policy=new OriginPolicy("https://dev.1m8.ai");
        for(String url:new String[]{"https://dev.1m8.ai/portal/","https://dev.1m8.ai:443/v1/mobile","https://DEV.1M8.AI/"})assertTrue(url,policy.trusted(url));
        for(String url:new String[]{"http://dev.1m8.ai/","https://dev.1m8.ai.evil.test/","https://evil.test/?next=https://dev.1m8.ai","https://user@dev.1m8.ai/","https://dev.1m8.ai:444/","file:///data","javascript:alert(1)","https://dev.1m8.ai@evil.test/"})assertFalse(url,policy.trusted(url));
    }
    @Test public void externalSchemesAreRestricted() {
        assertTrue(OriginPolicy.external("https://apps.apple.com/app/test"));assertTrue(OriginPolicy.external("tel:+12025550123"));
        assertFalse(OriginPolicy.external("intent://test"));assertFalse(OriginPolicy.external("file:///data"));assertFalse(OriginPolicy.external("javascript:alert(1)"));
    }
}
