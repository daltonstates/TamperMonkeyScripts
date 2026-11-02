import base64
from datetime import datetime, timezone, timedelta
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec=importlib.util.spec_from_file_location('guest',Path(__file__).with_name('GuestWorkflow.py'))
guest=importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)


class GuestTests(unittest.TestCase):
    def setUp(self):
        power = patch.object(guest.ctypes, 'windll', MagicMock(), create=True)
        power.start()
        self.addCleanup(power.stop)

    def settings(self, root):
        daily=root/'daily-settings.json'
        guest.write_report(daily, {'closeCompletedListings':True,'profiles':[{'name':str(i)} for i in range(3)]})
        return {'enabled':True,'dailySettings':str(daily),'dailyRunner':'DailyGiveaways.py',
                'recoverFailedProfiles':True,'jobInventoryVerified':True,'otherJobTasks':[]}

    def test_disabled_request_has_a_fresh_result_and_skip_reason(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(guest,'is_hyperv_guest',return_value=True):
            root=Path(folder); settings=self.settings(root); settings['enabled']=False
            guest.write_report(root/'vm-last-run.json',{'state':'finished','runId':'old'})
            publish=MagicMock()
            self.assertEqual(guest.run(settings,request={'runId':'b'*32},publisher=publish),0)
            report=guest.read_json(root/'vm-last-run.json')
            self.assertEqual(report['runId'],'b'*32)
            self.assertEqual(report['state'],'skipped')
            self.assertIn('disabled',report['reason'])
            self.assertTrue(report['endedAt'])
            self.assertTrue((root/'vm-last-skip.json').exists())
            self.assertFalse(report['shutdown']['eligible'])
            publish.assert_called_once()

    def test_startup_failure_is_reported_without_clearing_pending_work(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(guest,'is_hyperv_guest',return_value=True):
            root=Path(folder); settings=self.settings(root)
            guest.write_report(root/'daily-incomplete.json',{'proof':'preserve'})
            Path(settings['dailySettings']).unlink()
            self.assertEqual(guest.run(settings,request={'runId':'c'*32}),1)
            report=guest.read_json(root/'vm-last-run.json')
            self.assertEqual(report['state'],'failed')
            self.assertTrue(report['endedAt'])
            self.assertEqual(guest.read_json(root/'daily-incomplete.json'),{'proof':'preserve'})

    def test_finished_child_has_no_total_wait_timeout_and_exports_before_shutdown(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(guest,'is_hyperv_guest',return_value=True), \
             patch.object(guest.time,'sleep'):
            root=Path(folder); settings=self.settings(root)
            child=MagicMock(); child.poll.side_effect=[None,None,0]; child.wait.return_value=0
            def launch(command, **kwargs):
                self.assertIn('--recover-failures',command)
                self.assertIn('--requested',command)
                guest.write_report(root/'daily-last-run.json',{'runId':'d'*32,'startedAt':guest.utc_now(),'endedAt':guest.utc_now(),
                    'profiles':[{'state':'finished','listingClosed':True} for _ in range(3)]})
                return child
            publish=MagicMock()
            with patch.object(guest.subprocess,'Popen',side_effect=launch):
                self.assertEqual(guest.run(settings,request={'runId':'d'*32,'entryLimit':1},publisher=publish),0)
            child.wait.assert_called_once_with()
            report=guest.read_json(root/'vm-last-run.json')
            self.assertEqual(report['state'],'finished')
            self.assertTrue(report['shutdown']['eligible'])
            self.assertGreaterEqual(publish.call_count,4)
            self.assertFalse((root/'vm-last-success.json').exists()) # A limited check is not a full day's work.
            calls=guest.ctypes.windll.kernel32.SetThreadExecutionState.call_args_list
            self.assertEqual([call.args[0] for call in calls],[0x80000003,0x80000000])
            self.assertTrue(report['powerRequest']['displayRequired'])

    def test_late_transient_read_failures_do_not_reapply_startup_deadline(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(guest,'is_hyperv_guest',return_value=True):
            root=Path(folder); settings=self.settings(root); clock=[0]; polls=[0]; reads=[0]
            run_id='e'*32
            child=MagicMock()
            original_read=guest.read_json
            def poll():
                polls[0]+=1
                if polls[0] <= 240:
                    return None
                current=original_read(root/'daily-last-run.json')
                current.update(endedAt=guest.utc_now(),profiles=[{'state':'finished','listingClosed':True} for _ in range(3)])
                guest.write_report(root/'daily-last-run.json',current)
                return 0
            child.poll.side_effect=poll; child.wait.return_value=0
            def launch(command, **kwargs):
                guest.write_report(root/'daily-last-run.json',{'runId':run_id,'startedAt':guest.utc_now(),'profiles':[]})
                return child
            def read(path):
                if path.name=='daily-last-run.json':
                    reads[0]+=1
                    if reads[0]==10: raise PermissionError('sharing conflict while replacing current report')
                    if reads[0]==45: raise ValueError('partial JSON snapshot')
                    if reads[0]==90: return {'runId':'an older request'}
                return original_read(path)
            def sleep(seconds): clock[0]+=60
            with patch.object(guest.subprocess,'Popen',side_effect=launch), \
                 patch.object(guest,'read_json',side_effect=read), \
                 patch.object(guest.time,'monotonic',side_effect=lambda:clock[0]), \
                 patch.object(guest.time,'sleep',side_effect=sleep):
                self.assertEqual(guest.run(settings,request={'runId':run_id,'entryLimit':1}),0)
            report=original_read(root/'vm-last-run.json')
            self.assertEqual(report['state'],'finished')
            self.assertEqual(report['monitoringReadFailures'],3)
            self.assertNotIn('monitoringWarning',report)
            self.assertEqual(clock[0],4*3600)
            child.wait.assert_called_once_with()
            child.terminate.assert_not_called()

    def test_never_established_reporting_still_has_bounded_startup_check(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(guest,'is_hyperv_guest',return_value=True):
            root=Path(folder); settings=self.settings(root); clock=[0]
            child=MagicMock(); child.poll.return_value=None
            def sleep(seconds): clock[0]+=60
            with patch.object(guest.subprocess,'Popen',return_value=child), \
                 patch.object(guest.time,'monotonic',side_effect=lambda:clock[0]), \
                 patch.object(guest.time,'sleep',side_effect=sleep):
                self.assertEqual(guest.run(settings,request={'runId':'f'*32}),1)
            report=guest.read_json(root/'vm-last-run.json')
            self.assertIn('did not establish',report['reason'])
            self.assertIn('FileNotFoundError',report['reason'])
            self.assertTrue(report['queueStillActive'])
            self.assertFalse(report['shutdown']['eligible'])
            self.assertLessEqual(clock[0],180)
            child.terminate.assert_not_called()

    def test_established_but_continuously_unreadable_reporting_uses_monitoring_interval(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(guest,'is_hyperv_guest',return_value=True):
            root=Path(folder); settings=self.settings(root); clock=[0]; reads=[0]
            child=MagicMock(); child.poll.return_value=None
            original_read=guest.read_json
            def launch(command, **kwargs):
                guest.write_report(root/'daily-last-run.json',{'runId':'a'*32,'startedAt':guest.utc_now(),'profiles':[]})
                return child
            def read(path):
                if path.name=='daily-last-run.json':
                    reads[0]+=1
                    if reads[0]>1: raise PermissionError('persistent sharing failure')
                return original_read(path)
            def sleep(seconds): clock[0]+=60
            with patch.object(guest.subprocess,'Popen',side_effect=launch), \
                 patch.object(guest,'read_json',side_effect=read), \
                 patch.object(guest.time,'monotonic',side_effect=lambda:clock[0]), \
                 patch.object(guest.time,'sleep',side_effect=sleep):
                self.assertEqual(guest.run(settings,request={'runId':'a'*32}),1)
            report=original_read(root/'vm-last-run.json')
            self.assertIn('remained unreadable',report['reason'])
            self.assertNotIn('did not establish',report['reason'])
            self.assertIn('persistent sharing failure',report['monitoringLastReadError'])
            self.assertTrue(report['queueStillActive'])
            self.assertEqual(clock[0],16*60)
            child.terminate.assert_not_called()

    def test_another_designated_job_defers_shutdown_and_unknown_inventory_is_safe(self):
        with tempfile.TemporaryDirectory() as folder:
            settings=self.settings(Path(folder)); settings['otherJobTasks']=['Other automation']
            result=guest.shutdown_eligibility(settings,[{'TaskName':'Other automation','State':'Running'}])
            self.assertFalse(result['eligible']); self.assertIn('Other automation',result['reason'])
            self.assertFalse(guest.shutdown_eligibility(settings,[])['eligible'])
            settings['otherJobTasks']=[]; settings['activeJobsFile']=str(Path(folder)/'jobs.json')
            guest.write_report(Path(settings['activeJobsFile']),{'jobs':[{'name':'export','state':'queued'}]})
            self.assertFalse(guest.shutdown_eligibility(settings)['eligible'])
            guest.write_report(Path(settings['activeJobsFile']),{'jobs':[]})
            self.assertTrue(guest.shutdown_eligibility(settings)['eligible'])
            settings.pop('jobInventoryVerified')
            self.assertFalse(guest.shutdown_eligibility(settings)['eligible'])

    def test_kvp_document_round_trip_includes_skip_and_rejects_oversized_export(self):
        bundle={'schema':1,'runId':'a'*32,'files':{'vm-last-skip.json':{'reason':'disabled'}}}
        encoded,digest=guest.encode_bundle(bundle)
        raw=gzip.decompress(base64.b64decode(encoded))
        self.assertEqual(json.loads(raw),bundle)
        self.assertEqual(hashlib.sha256(raw).hexdigest(),digest)
        import secrets
        with self.assertRaisesRegex(ValueError,'bound'):
            guest.encode_bundle({'noise':secrets.token_hex(200000)})


if __name__=='__main__': unittest.main()
